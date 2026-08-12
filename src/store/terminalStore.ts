import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  createTerminal,
  killTerminal,
  resizeTerminal,
  spawnTerminalScript,
  writeTerminal,
  type TerminalSpawnResult,
} from '../lib/ipc/terminal'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'
import type { TerminalTab } from '../types'
import {
  DEFAULT_TERMINAL_PROFILE,
  getTerminalProfile,
  loadTerminalProfileSettings,
} from '@/lib/terminal/terminalProfiles'
import { ensureTerminalProfileTrust } from '@/lib/terminal/terminalProfileTrust'
import { isProjectTrusted } from '../lib/workspaceTrust'
import {
  disambiguateTerminalName,
  resolveNewTerminalName,
  terminalDisplayLabel,
} from '../utils/terminalName'
import { translate } from '../lib/i18n'
import {
  getTerminalScrollback,
  scrollbackMaxChars,
} from '@/lib/terminal/terminalScrollbackSettings'
import {
  absorbInputForHistory,
  appendTerminalByteRing,
  buildTerminalOutputSnapshot,
  createTerminalByteRing,
  decodeScrollbackBytes,
  encodeScrollbackText,
  loadTerminalOutputSnapshot,
  pushCommandHistory,
  saveTerminalOutputSnapshot,
  terminalByteRingToBytes,
  type TerminalByteRing,
  truncateScrollbackBytes,
} from '@/lib/terminal/terminalSessionPersist'
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  normalizePtySize,
} from '@/lib/terminal/terminalPtySize'
import { shouldKeepShellAfterExit } from '@/lib/terminal/terminalShellLifecycle'
import { planTerminalSpawn } from '@/lib/terminal/terminalSpawnPlan'
import {
  effectiveShellForTerminalName,
  isTerminalShellId,
  normalizeTerminalShell,
  terminalShellLabelKey,
  type TerminalShellId,
} from '@/lib/terminal/terminalShell'
import { clearTerminalCommandActivity } from '@/lib/terminal/terminalCommandActivity'
import { isSessionPersistEnabled } from '../lib/sessionPersistSettings'
import { recordPerformanceThroughput } from '../lib/performanceDiagnostics'

export const MAX_TERMINALS_PER_PROJECT = 10
/** @deprecated Cleared on boot; durable metadata lives in workspaceSessionPersist. */
const LEGACY_SESSION_STORAGE_KEY = 'qingcode:terminal-layout'
const OUTPUT_PERSIST_DEBOUNCE_MS = 1_200
const OUTPUT_PERSIST_IDLE_TIMEOUT_MS = 4_000

/** 够"快"才算启动失败：进程在此时长（毫秒）内非零退出，视为秒退并提示。 */
const QUICK_FAIL_THRESHOLD_MS = 2000
/** If xterm never reports a size (panel closed), spawn with defaults. */
const PTY_SPAWN_FALLBACK_MS = 2500

const ptySpawnInFlight = new Set<string>()
/** Prevents concurrent App effects from double-respawning restored tabs. */
const restoreSpawnInFlight = new Set<string>()
const ptySpawnFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Last fitted size per tab — used when restarting before the next fit. */
const lastPtySize = new Map<string, { cols: number; rows: number }>()
/** Kills from close/restart — do not auto-respawn a shell for these. */
const intentionalPtyKills = new Set<string>()
const reportedShellFallbacks = new Set<string>()

function isGeneratedShellName(tab: TerminalTab): boolean {
  if (/^(终端|Terminal) \d+$/.test(tab.name)) return true
  const shellIds = [tab.shell, tab.resolvedShell].filter(
    (shell): shell is TerminalShellId => shell !== undefined
  )
  return shellIds.some(shell => {
    const label = translate(terminalShellLabelKey(shell))
    return tab.name === label || tab.name.startsWith(`${label} (`)
  })
}

function applyTerminalSpawnResult(id: string, result: TerminalSpawnResult | null | undefined) {
  const resolvedShell = isTerminalShellId(result?.resolvedShell) ? result.resolvedShell : undefined
  if (resolvedShell && resolvedShell !== 'auto') {
    useTerminalStore.setState(state => {
      const current = state.terminals.find(terminal => terminal.id === id)
      if (!current) return state
      let name = current.name
      if (
        current.profileId === DEFAULT_TERMINAL_PROFILE.id &&
        !current.launchCommand.trim() &&
        isGeneratedShellName(current)
      ) {
        name = disambiguateTerminalName(
          translate(terminalShellLabelKey(resolvedShell)),
          state.terminals.filter(terminal => terminal.id !== id).map(terminal => terminal.name)
        )
      }
      return {
        terminals: state.terminals.map(terminal =>
          terminal.id === id ? { ...terminal, name, resolvedShell } : terminal
        ),
      }
    })
  }

  const fallbackFrom = isTerminalShellId(result?.fallbackFrom) ? result.fallbackFrom : undefined
  if (!fallbackFrom || !resolvedShell || fallbackFrom === resolvedShell) return
  const fallbackKey = `${fallbackFrom}->${resolvedShell}`
  if (reportedShellFallbacks.has(fallbackKey)) return
  reportedShellFallbacks.add(fallbackKey)
  const resolvedLabel = translate(terminalShellLabelKey(resolvedShell))
  const message =
    fallbackFrom === 'auto' || fallbackFrom === 'pwsh'
      ? translate('未检测到 PowerShell 7，已自动改用 {shell}', { shell: resolvedLabel })
      : translate('未找到 {requested}，已自动改用 {resolved}', {
          requested: translate(terminalShellLabelKey(fallbackFrom)),
          resolved: resolvedLabel,
        })
  useProjectStore.getState().pushToast('info', message)
}

function clearPtySpawnFallback(id: string) {
  const timer = ptySpawnFallbackTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    ptySpawnFallbackTimers.delete(id)
  }
}

function rememberPtySize(id: string, cols: number, rows: number) {
  lastPtySize.set(id, normalizePtySize(cols, rows))
}

function schedulePtySpawnFallback(id: string, spawn: () => void) {
  clearPtySpawnFallback(id)
  ptySpawnFallbackTimers.set(
    id,
    setTimeout(() => {
      ptySpawnFallbackTimers.delete(id)
      spawn()
    }, PTY_SPAWN_FALLBACK_MS)
  )
}

function markIntentionalPtyKill(id: string) {
  intentionalPtyKills.add(id)
}

function consumeIntentionalPtyKill(id: string): boolean {
  if (!intentionalPtyKills.has(id)) return false
  intentionalPtyKills.delete(id)
  return true
}

type TerminalOutputListener = (data: Uint8Array) => void

/** Re-open a shell after OpenCode/TUI tore down the ConPTY; keep scrollback. */
async function respawnShellAfterExit(id: string): Promise<void> {
  const tab = useTerminalStore.getState().terminals.find(terminal => terminal.id === id)
  if (!tab || tab.ptySpawnPending) return
  if (ptySpawnInFlight.has(id)) return
  ptySpawnInFlight.add(id)
  const size = lastPtySize.get(id) ?? {
    cols: DEFAULT_PTY_COLS,
    rows: DEFAULT_PTY_ROWS,
  }
  useTerminalStore.setState(s => ({
    terminals: s.terminals.map(terminal =>
      terminal.id === id
        ? {
            ...terminal,
            status: 'running',
            exitCode: null,
            startedAt: Date.now(),
          }
        : terminal
    ),
  }))
  try {
    const result = await createTerminal({
      id,
      cwd: tab.cwd,
      cols: size.cols,
      rows: size.rows,
      shell: tab.shell ?? null,
    })
    applyTerminalSpawnResult(id, result)
  } catch (e) {
    console.error('respawnShellAfterExit failed:', e)
    useTerminalStore.setState(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id ? { ...terminal, status: 'exited', exitCode: null } : terminal
      ),
    }))
  } finally {
    ptySpawnInFlight.delete(id)
  }
}

/** Always-on ring used for persistence + restore replay. */
const terminalScrollbackRings = new Map<string, TerminalByteRing>()
const terminalCommandHistory = new Map<string, string[]>()
const terminalInputPending = new Map<string, string>()
const terminalOutputListeners = new Map<string, Set<TerminalOutputListener>>()
const terminalRingUpdatedAt = new Map<string, number>()
const terminalPendingOutput = new Map<string, Uint8Array[]>()
const terminalOutputFlushTimers = new Map<string, number>()

let outputPersistTimer: ReturnType<typeof setTimeout> | null = null
let outputPersistIdle: number | null = null

function maxBufferedBytes(): number {
  return scrollbackMaxChars(getTerminalScrollback())
}

function touchRing(id: string, bytes: Uint8Array) {
  const maxBytes = maxBufferedBytes()
  const ring =
    terminalScrollbackRings.get(id) ?? createTerminalByteRing(maxBytes)
  appendTerminalByteRing(ring, bytes, maxBytes)
  terminalScrollbackRings.set(id, ring)
  terminalRingUpdatedAt.set(id, Date.now())
  scheduleTerminalOutputPersist()
}

function combineOutputChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

function flushTerminalOutput(id: string) {
  terminalOutputFlushTimers.delete(id)
  const chunks = terminalPendingOutput.get(id)
  terminalPendingOutput.delete(id)
  if (!chunks?.length) return
  const listeners = terminalOutputListeners.get(id)
  if (!listeners?.size) return
  const combined = combineOutputChunks(chunks)
  listeners.forEach(listener => listener(combined))
}

function queueTerminalOutput(id: string, bytes: Uint8Array) {
  const chunks = terminalPendingOutput.get(id) ?? []
  chunks.push(bytes)
  terminalPendingOutput.set(id, chunks)
  if (terminalOutputFlushTimers.has(id)) return
  terminalOutputFlushTimers.set(
    id,
    window.setTimeout(() => flushTerminalOutput(id), 16),
  )
}

function publishTerminalOutput(id: string, data: number[]) {
  const bytes = new Uint8Array(data)
  recordPerformanceThroughput('terminalBytes', bytes.length)
  touchRing(id, bytes)

  const listeners = terminalOutputListeners.get(id)
  if (listeners?.size) {
    queueTerminalOutput(id, bytes)
  }
}

function clearTerminalOutput(id: string, options?: { persist?: boolean }) {
  terminalScrollbackRings.delete(id)
  terminalPendingOutput.delete(id)
  const flushTimer = terminalOutputFlushTimers.get(id)
  if (flushTimer !== undefined) window.clearTimeout(flushTimer)
  terminalOutputFlushTimers.delete(id)
  terminalCommandHistory.delete(id)
  terminalInputPending.delete(id)
  terminalRingUpdatedAt.delete(id)
  clearTerminalCommandActivity(id)
  if (options?.persist !== false) scheduleTerminalOutputPersist()
}

/** Seed live rings from durable storage (called during workspace hydrate). */
export function seedTerminalOutputFromPersist(
  id: string,
  scrollback: string,
  history: string[] = []
) {
  if (scrollback) {
    const bytes = truncateScrollbackBytes(
      encodeScrollbackText(scrollback),
      getTerminalScrollback(),
      maxBufferedBytes()
    )
    terminalScrollbackRings.set(id, createTerminalByteRing(maxBufferedBytes(), bytes))
    terminalRingUpdatedAt.set(id, Date.now())
  }
  if (history.length > 0) {
    terminalCommandHistory.set(id, [...history])
  }
}

/** Hydrate all persisted scrollback/history entries that match known tab ids. */
export function hydrateTerminalOutputForTabs(terminalIds: Iterable<string>) {
  if (!isSessionPersistEnabled()) return
  const snapshot = loadTerminalOutputSnapshot()
  if (!snapshot) return
  const wanted = new Set(terminalIds)
  for (const [id, entry] of Object.entries(snapshot.terminals)) {
    if (!wanted.has(id)) continue
    seedTerminalOutputFromPersist(id, entry.scrollback, entry.history)
  }
}

export function getTerminalCommandHistory(id: string): string[] {
  return terminalCommandHistory.get(id) ?? []
}

export function subscribeTerminalOutput(id: string, listener: TerminalOutputListener) {
  // Deliver already-batched live bytes to existing views before a new view replays the ring.
  // This avoids both missing history and duplicating the pending tail in the new xterm.
  if (terminalPendingOutput.has(id)) flushTerminalOutput(id)
  const listeners = terminalOutputListeners.get(id) ?? new Set<TerminalOutputListener>()
  listeners.add(listener)
  terminalOutputListeners.set(id, listeners)

  // A newly mounted xterm needs one complete replay. Live output is batched below.
  const ring = terminalByteRingToBytes(terminalScrollbackRings.get(id))
  if (ring.length) listener(ring)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      terminalOutputListeners.delete(id)
      terminalPendingOutput.delete(id)
      const flushTimer = terminalOutputFlushTimers.get(id)
      if (flushTimer !== undefined) window.clearTimeout(flushTimer)
      terminalOutputFlushTimers.delete(id)
    }
  }
}

function collectOutputPersistPayload(): Record<
  string,
  { scrollback: string; history: string[]; updatedAt?: number }
> {
  const terminals: Record<string, { scrollback: string; history: string[]; updatedAt?: number }> =
    {}
  for (const tab of useTerminalStore.getState().terminals) {
    const scrollback = decodeScrollbackBytes(
      terminalByteRingToBytes(terminalScrollbackRings.get(tab.id)),
    )
    const history = terminalCommandHistory.get(tab.id) ?? []
    if (!scrollback && history.length === 0) continue
    terminals[tab.id] = {
      scrollback,
      history,
      updatedAt: terminalRingUpdatedAt.get(tab.id),
    }
  }
  return terminals
}

export function persistTerminalOutputNow() {
  if (outputPersistTimer) {
    clearTimeout(outputPersistTimer)
    outputPersistTimer = null
  }
  if (outputPersistIdle !== null) {
    if (typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(outputPersistIdle)
    }
    outputPersistIdle = null
  }
  if (!isSessionPersistEnabled()) return
  const terminals = collectOutputPersistPayload()
  const snapshot = buildTerminalOutputSnapshot({
    terminals,
    scrollbackLines: getTerminalScrollback(),
  })
  saveTerminalOutputSnapshot(snapshot)
}

export function scheduleTerminalOutputPersist() {
  if (outputPersistTimer || outputPersistIdle !== null) return
  outputPersistTimer = setTimeout(() => {
    outputPersistTimer = null
    if (typeof window.requestIdleCallback === 'function') {
      outputPersistIdle = window.requestIdleCallback(
        () => {
          outputPersistIdle = null
          persistTerminalOutputNow()
        },
        { timeout: OUTPUT_PERSIST_IDLE_TIMEOUT_MS },
      )
    } else {
      persistTerminalOutputNow()
    }
  }, OUTPUT_PERSIST_DEBOUNCE_MS)
}

function recordTypedInput(id: string, data: string) {
  const { pending, commands } = absorbInputForHistory(terminalInputPending.get(id) ?? '', data)
  terminalInputPending.set(id, pending)
  if (commands.length === 0) return
  let history = terminalCommandHistory.get(id) ?? []
  for (const command of commands) {
    history = pushCommandHistory(history, command)
  }
  terminalCommandHistory.set(id, history)
  scheduleTerminalOutputPersist()
}

export type ShellKind = 'ps1' | 'bat' | 'sh' | 'command' | 'interactive' | 'script'

/** Dual: primary|secondary. 田: primary=TL, secondary=TR, bl=BL, br=BR. */
export type TerminalFocusPane = 'primary' | 'secondary' | 'bl' | 'br'

export const TERMINAL_FOCUS_PANES: readonly TerminalFocusPane[] = [
  'primary',
  'secondary',
  'bl',
  'br',
] as const

export function isTerminalFocusPane(value: unknown): value is TerminalFocusPane {
  return (
    value === 'primary' || value === 'secondary' || value === 'bl' || value === 'br'
  )
}

/** Pane that owns a session; legacy tabs without `pane` belong to primary. */
export function terminalPaneOf(tab: Pick<TerminalTab, 'pane'>): TerminalFocusPane {
  return tab.pane ?? 'primary'
}

/** Infer missing `pane` ownership from dual/田 active bindings (legacy shared pool). */
export function inferTerminalPaneOwnership(
  terminals: TerminalTab[],
  bindings: {
    activeTerminalByProject: Record<string, string>
    secondaryTerminalByProject?: Record<string, string>
    blTerminalByProject?: Record<string, string>
    brTerminalByProject?: Record<string, string>
  },
): TerminalTab[] {
  const owner = new Map<string, TerminalFocusPane>()
  for (const id of Object.values(bindings.activeTerminalByProject)) {
    owner.set(id, 'primary')
  }
  for (const id of Object.values(bindings.secondaryTerminalByProject ?? {})) {
    owner.set(id, 'secondary')
  }
  for (const id of Object.values(bindings.blTerminalByProject ?? {})) {
    owner.set(id, 'bl')
  }
  for (const id of Object.values(bindings.brTerminalByProject ?? {})) {
    owner.set(id, 'br')
  }
  let changed = false
  const next = terminals.map(tab => {
    if (tab.pane) return tab
    changed = true
    return { ...tab, pane: owner.get(tab.id) ?? 'primary' }
  })
  return changed ? next : terminals
}

export type TerminalDropPosition = 'before' | 'after'

/** Move one terminal beside another while preserving every unrelated tab's order. */
export function reorderTerminalTabs(
  terminals: TerminalTab[],
  sourceId: string,
  targetId: string,
  position: TerminalDropPosition,
): TerminalTab[] {
  if (sourceId === targetId) return terminals
  const source = terminals.find(tab => tab.id === sourceId)
  const target = terminals.find(tab => tab.id === targetId)
  if (!source || !target || source.projectId !== target.projectId) return terminals

  const next = terminals.filter(tab => tab.id !== sourceId)
  const targetIndex = next.findIndex(tab => tab.id === targetId)
  if (targetIndex < 0) return terminals
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source)
  return next.every((tab, index) => tab === terminals[index]) ? terminals : next
}

interface TerminalState {
  terminals: TerminalTab[]
  activeTerminalId: string | null
  activeTerminalByProject: Record<string, string>
  /** Right pane in dual; top-right in 田. */
  secondaryTerminalId: string | null
  secondaryTerminalByProject: Record<string, string>
  /** Bottom-left pane in 田 layout. */
  blTerminalId: string | null
  blTerminalByProject: Record<string, string>
  /** Bottom-right pane in 田 layout. */
  brTerminalId: string | null
  brTerminalByProject: Record<string, string>
  /** Which dual/田 pane receives tab clicks / keyboard focus. */
  terminalFocusPane: TerminalFocusPane
  addTerminal: (
    projectPath: string,
    projectId: string,
    profileId?: string
  ) => Promise<string | null>
  addScriptTerminal: (
    projectId: string,
    cwd: string,
    shellKind: ShellKind,
    target: string,
    env: Record<string, string>,
    name: string,
    linkage?: { runConfigId: string; runTaskId: string }
  ) => Promise<string | null>
  closeTerminal: (id: string) => Promise<void>
  closeOtherTerminals: (id: string) => Promise<void>
  closeAllProjectTerminals: (projectId: string) => Promise<void>
  closeProjectTerminals: (projectId: string) => Promise<void>
  restartTerminal: (id: string, options?: { preserveOutput?: boolean }) => Promise<void>
  /** Seed tabs from durable workspace session (no PTY yet). */
  hydrateTerminalSessions: (
    terminals: TerminalTab[],
    bindings: {
      activeTerminalByProject: Record<string, string>
      secondaryTerminalByProject?: Record<string, string>
      blTerminalByProject?: Record<string, string>
      brTerminalByProject?: Record<string, string>
    }
  ) => void
  /**
   * Replace terminal metadata for specific projects (named workspace restore).
   * Other projects' terminals are left alone. Kills PTYs for replaced ids.
   */
  replaceTerminalSessionsForProjects: (
    projectIds: string[],
    terminals: TerminalTab[],
    bindings: {
      activeTerminalByProject: Record<string, string>
      secondaryTerminalByProject?: Record<string, string>
      blTerminalByProject?: Record<string, string>
      brTerminalByProject?: Record<string, string>
    }
  ) => Promise<void>
  /** Spawn PTYs for tabs restored after restart (once). */
  spawnRestoredTerminals: (projectId: string) => Promise<void>
  activateProject: (projectId: string) => void
  updateProjectPath: (projectId: string, path: string) => void
  setActiveTerminal: (id: string) => void
  reorderTerminal: (
    sourceId: string,
    targetId: string,
    position: TerminalDropPosition,
  ) => void
  setTerminalFocusPane: (pane: TerminalFocusPane) => void
  setSecondaryTerminal: (id: string | null) => void
  /**
   * Ensure the dual-terminal right pane shows a terminal owned by `secondary`.
   * Does not steal primary sessions; empty when the pane has no tabs.
   */
  ensureSecondaryTerminal: (projectId: string) => void
  /**
   * Ensure 田 panes bind to sessions they own (no auto-create, no cross-pane steal).
   * Empty panes stay null for EmptyState.
   */
  ensureQuadTerminals: (projectId: string) => void
  /** Id bound to a dual/田 pane (null if empty). */
  paneTerminalId: (pane: TerminalFocusPane) => string | null
  /** Terminal that should receive find/clear / status focus in dual/田 mode. */
  focusedTerminalId: () => string | null
  writeToTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
  /**
   * Create the PTY after xterm has fitted. Idempotent while `ptySpawnPending`.
   * Pass measured cols/rows so TUIs (e.g. OpenCode) start on the real grid.
   */
  spawnPendingTerminal: (id: string, cols: number, rows: number) => Promise<void>
  renameTerminal: (id: string, name: string) => void
  initializeTerminalEvents: () => Promise<UnlistenFn>
}

try {
  // Legacy per-window key — durable metadata moved to workspaceSessionPersist.
  sessionStorage.removeItem(LEGACY_SESSION_STORAGE_KEY)
} catch {
  /* ignore */
}

type PaneBindingSlice = {
  activeTerminalId: string | null
  secondaryTerminalId: string | null
  blTerminalId: string | null
  brTerminalId: string | null
  activeTerminalByProject: Record<string, string>
  secondaryTerminalByProject: Record<string, string>
  blTerminalByProject: Record<string, string>
  brTerminalByProject: Record<string, string>
}

function readPaneTerminalId(s: PaneBindingSlice, pane: TerminalFocusPane): string | null {
  switch (pane) {
    case 'primary':
      return s.activeTerminalId
    case 'secondary':
      return s.secondaryTerminalId
    case 'bl':
      return s.blTerminalId
    case 'br':
      return s.brTerminalId
  }
}

/** Assign `id` as the active session for `pane` (no cross-pane steal/swap). */
function bindTerminalToPane(
  s: PaneBindingSlice,
  projectId: string,
  pane: TerminalFocusPane,
  id: string
): Partial<PaneBindingSlice> {
  const next: PaneBindingSlice = {
    activeTerminalId: s.activeTerminalId,
    secondaryTerminalId: s.secondaryTerminalId,
    blTerminalId: s.blTerminalId,
    brTerminalId: s.brTerminalId,
    activeTerminalByProject: { ...s.activeTerminalByProject },
    secondaryTerminalByProject: { ...s.secondaryTerminalByProject },
    blTerminalByProject: { ...s.blTerminalByProject },
    brTerminalByProject: { ...s.brTerminalByProject },
  }

  const writePane = (target: TerminalFocusPane, terminalId: string | null) => {
    switch (target) {
      case 'primary':
        next.activeTerminalId = terminalId
        if (terminalId) next.activeTerminalByProject[projectId] = terminalId
        else delete next.activeTerminalByProject[projectId]
        break
      case 'secondary':
        next.secondaryTerminalId = terminalId
        if (terminalId) next.secondaryTerminalByProject[projectId] = terminalId
        else delete next.secondaryTerminalByProject[projectId]
        break
      case 'bl':
        next.blTerminalId = terminalId
        if (terminalId) next.blTerminalByProject[projectId] = terminalId
        else delete next.blTerminalByProject[projectId]
        break
      case 'br':
        next.brTerminalId = terminalId
        if (terminalId) next.brTerminalByProject[projectId] = terminalId
        else delete next.brTerminalByProject[projectId]
        break
    }
  }

  // Clear stale bindings if this id was incorrectly pointed at from another pane.
  for (const p of TERMINAL_FOCUS_PANES) {
    if (p === pane) continue
    if (readPaneTerminalId(s, p) === id) writePane(p, null)
  }
  writePane(pane, id)
  return next
}

function clearClosedFromPanes(
  s: PaneBindingSlice,
  projectId: string,
  closedId: string,
  remaining: TerminalTab[],
): Partial<PaneBindingSlice> {
  const pickForPane = (pane: TerminalFocusPane) => {
    for (const tab of remaining) {
      if (tab.projectId !== projectId) continue
      if (terminalPaneOf(tab) !== pane) continue
      if (tab.id === closedId) continue
      return tab.id
    }
    return null
  }

  let activeTerminalId = s.activeTerminalId
  let secondaryTerminalId = s.secondaryTerminalId
  let blTerminalId = s.blTerminalId
  let brTerminalId = s.brTerminalId
  const activeTerminalByProject = { ...s.activeTerminalByProject }
  const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
  const blTerminalByProject = { ...s.blTerminalByProject }
  const brTerminalByProject = { ...s.brTerminalByProject }

  if (activeTerminalId === closedId) {
    activeTerminalId = pickForPane('primary')
    if (activeTerminalId) activeTerminalByProject[projectId] = activeTerminalId
    else delete activeTerminalByProject[projectId]
  }

  if (secondaryTerminalId === closedId) {
    secondaryTerminalId = pickForPane('secondary')
    if (secondaryTerminalId) secondaryTerminalByProject[projectId] = secondaryTerminalId
    else delete secondaryTerminalByProject[projectId]
  }

  if (blTerminalId === closedId) {
    blTerminalId = pickForPane('bl')
    if (blTerminalId) blTerminalByProject[projectId] = blTerminalId
    else delete blTerminalByProject[projectId]
  }

  if (brTerminalId === closedId) {
    brTerminalId = pickForPane('br')
    if (brTerminalId) brTerminalByProject[projectId] = brTerminalId
    else delete brTerminalByProject[projectId]
  }

  return {
    activeTerminalId,
    secondaryTerminalId,
    blTerminalId,
    brTerminalId,
    activeTerminalByProject,
    secondaryTerminalByProject,
    blTerminalByProject,
    brTerminalByProject,
  }
}

function clearProjectPaneMaps(
  s: PaneBindingSlice,
  projectId: string,
  closedIds: string[]
): Partial<PaneBindingSlice> {
  const activeTerminalByProject = { ...s.activeTerminalByProject }
  const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
  const blTerminalByProject = { ...s.blTerminalByProject }
  const brTerminalByProject = { ...s.brTerminalByProject }
  delete activeTerminalByProject[projectId]
  delete secondaryTerminalByProject[projectId]
  delete blTerminalByProject[projectId]
  delete brTerminalByProject[projectId]
  return {
    activeTerminalId: closedIds.includes(s.activeTerminalId ?? '') ? null : s.activeTerminalId,
    secondaryTerminalId: closedIds.includes(s.secondaryTerminalId ?? '')
      ? null
      : s.secondaryTerminalId,
    blTerminalId: closedIds.includes(s.blTerminalId ?? '') ? null : s.blTerminalId,
    brTerminalId: closedIds.includes(s.brTerminalId ?? '') ? null : s.brTerminalId,
    activeTerminalByProject,
    secondaryTerminalByProject,
    blTerminalByProject,
    brTerminalByProject,
  }
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: null,
  activeTerminalByProject: {},
  secondaryTerminalId: null,
  secondaryTerminalByProject: {},
  blTerminalId: null,
  blTerminalByProject: {},
  brTerminalId: null,
  brTerminalByProject: {},
  terminalFocusPane: 'primary',

  reorderTerminal: (sourceId, targetId, position) => {
    set(state => ({
      terminals: reorderTerminalTabs(state.terminals, sourceId, targetId, position),
    }))
  },

  addTerminal: async (projectPath: string, projectId: string, profileId?: string) => {
    const project =
      useProjectStore.getState().projects.find(p => p.id === projectId) ??
      (useProjectStore.getState().currentProject?.id === projectId
        ? useProjectStore.getState().currentProject
        : null)
    if (project && !project.ephemeral && !isProjectTrusted(project)) {
      useProjectStore.getState().pushToast('info', translate('当前为受限模式，无法打开终端'))
      return null
    }
    const sameProject = get().terminals.filter(t => t.projectId === projectId)
    if (sameProject.length >= MAX_TERMINALS_PER_PROJECT) {
      useProjectStore
        .getState()
        .pushToast('info', `每个项目最多可创建 ${MAX_TERMINALS_PER_PROJECT} 个终端`)
      return null
    }
    const profile = getTerminalProfile(profileId)
    if (!(await ensureTerminalProfileTrust(profile))) return null
    const shell = normalizeTerminalShell(profile.shell)
    const id = crypto.randomUUID()
    const profileSettings = loadTerminalProfileSettings()
    const nameShell = effectiveShellForTerminalName(shell, profileSettings.defaultShell)
    const shellLabel = translate(terminalShellLabelKey(nameShell))
    const baseName = resolveNewTerminalName(
      profile.name,
      profile.command,
      DEFAULT_TERMINAL_PROFILE.name,
      shellLabel
    )
    const focusPane = get().terminalFocusPane
    const tab: TerminalTab = {
      id,
      name: disambiguateTerminalName(
        baseName,
        sameProject.map(terminal => terminal.name)
      ),
      projectId,
      cwd: projectPath,
      profileId: profile.id,
      shell,
      // `;` joins multi-line profile commands for PowerShell-family shells.
      launchCommand: profile.command.trim().replace(/\s*\n+\s*/g, '; '),
      pane: focusPane,
      // OSC titles rename the tab (cwd / apps); generic shell noise is filtered in UI.
      allowTitleRename: true,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      ptySpawnPending: true,
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      ...bindTerminalToPane(s, projectId, focusPane, id),
    }))
    // Ensure the panel has a non-zero height before xterm fit → PTY spawn.
    useUIStore.getState().openTerminalPanel()
    schedulePtySpawnFallback(id, () => {
      void get().spawnPendingTerminal(id, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS)
    })
    return id
  },

  addScriptTerminal: async (
    projectId: string,
    cwd: string,
    shellKind: ShellKind,
    target: string,
    env: Record<string, string>,
    name: string,
    linkage?
  ) => {
    const project =
      useProjectStore.getState().projects.find(p => p.id === projectId) ??
      (useProjectStore.getState().currentProject?.id === projectId
        ? useProjectStore.getState().currentProject
        : null)
    if (project && !project.ephemeral && !isProjectTrusted(project)) {
      useProjectStore.getState().pushToast('info', translate('当前为受限模式，无法运行任务'))
      return null
    }
    const sameProject = get().terminals.filter(t => t.projectId === projectId)
    if (sameProject.length >= MAX_TERMINALS_PER_PROJECT) {
      useProjectStore
        .getState()
        .pushToast('info', `每个项目最多可创建 ${MAX_TERMINALS_PER_PROJECT} 个终端`)
      return null
    }
    const id = crypto.randomUUID()
    const focusPane = get().terminalFocusPane
    const tab: TerminalTab = {
      id,
      name,
      projectId,
      cwd,
      launchCommand: target,
      shellKind,
      env,
      pane: focusPane,
      allowTitleRename: false,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      ptySpawnPending: true,
      ...(linkage?.runConfigId && linkage.runTaskId
        ? { runConfigId: linkage.runConfigId, runTaskId: linkage.runTaskId }
        : {}),
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      ...bindTerminalToPane(s, projectId, focusPane, id),
    }))
    useUIStore.getState().openTerminalPanel()
    schedulePtySpawnFallback(id, () => {
      void get().spawnPendingTerminal(id, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS)
    })
    return id
  },

  closeTerminal: async (id: string) => {
    clearPtySpawnFallback(id)
    ptySpawnInFlight.delete(id)
    lastPtySize.delete(id)
    markIntentionalPtyKill(id)
    const terminal = get().terminals.find(candidate => candidate.id === id)
    // Restored metadata has no PTY until its first spawn. Removing an opted-out
    // run-config tab must not call kill_terminal or show a false close error.
    if (!terminal?.awaitingRestoreSpawn) {
      try {
        await killTerminal(id)
      } catch (error) {
        useProjectStore
          .getState()
          .pushToast('error', translate('关闭终端失败: {error}', { error: String(error) }))
      }
    }
    set(s => {
      const closed = s.terminals.find(t => t.id === id)
      const terminals = s.terminals.filter(t => t.id !== id)
      if (!closed) return { terminals }
      return {
        terminals,
        ...clearClosedFromPanes(s, closed.projectId, id, terminals),
      }
    })
    clearTerminalOutput(id)
  },

  closeOtherTerminals: async (id: string) => {
    const keep = get().terminals.find(t => t.id === id)
    if (!keep) return
    const keepPane = terminalPaneOf(keep)
    const others = get()
      .terminals.filter(
        t =>
          t.projectId === keep.projectId &&
          t.id !== id &&
          terminalPaneOf(t) === keepPane,
      )
      .map(t => t.id)
    for (const tid of others) {
      clearPtySpawnFallback(tid)
      ptySpawnInFlight.delete(tid)
      lastPtySize.delete(tid)
      markIntentionalPtyKill(tid)
    }
    await Promise.all(others.map(tid => killTerminal(tid).catch(() => undefined)))
    set(s => {
      const otherSet = new Set(others)
      const terminals = s.terminals.filter(t => !otherSet.has(t.id))
      return {
        terminals,
        ...bindTerminalToPane(s, keep.projectId, keepPane, id),
        terminalFocusPane: keepPane,
      }
    })
    others.forEach(closedId => clearTerminalOutput(closedId))
  },

  closeAllProjectTerminals: async (projectId: string) => {
    const ids = get()
      .terminals.filter(t => t.projectId === projectId)
      .map(t => t.id)
    for (const id of ids) {
      clearPtySpawnFallback(id)
      ptySpawnInFlight.delete(id)
      lastPtySize.delete(id)
      markIntentionalPtyKill(id)
    }
    await Promise.all(ids.map(id => killTerminal(id).catch(() => undefined)))
    set(s => ({
      terminals: s.terminals.filter(t => t.projectId !== projectId),
      ...clearProjectPaneMaps(s, projectId, ids),
    }))
    ids.forEach(id => clearTerminalOutput(id))
  },

  closeProjectTerminals: async (projectId: string) => {
    const ids = get()
      .terminals.filter(terminal => terminal.projectId === projectId)
      .map(terminal => terminal.id)
    for (const id of ids) {
      clearPtySpawnFallback(id)
      ptySpawnInFlight.delete(id)
      lastPtySize.delete(id)
      markIntentionalPtyKill(id)
    }
    await Promise.all(ids.map(id => killTerminal(id).catch(() => undefined)))
    set(s => ({
      terminals: s.terminals.filter(terminal => terminal.projectId !== projectId),
      ...clearProjectPaneMaps(s, projectId, ids),
    }))
    ids.forEach(id => clearTerminalOutput(id))
  },

  restartTerminal: async (id: string, options) => {
    const tab = get().terminals.find(terminal => terminal.id === id)
    if (!tab) return
    // Profile terminals store profileId + launchCommand without shellKind.
    // Run-config tasks set shellKind and are gated by ensureRunTrust instead.
    if (tab.launchCommand && tab.profileId && !tab.shellKind) {
      const profile = getTerminalProfile(tab.profileId)
      if (
        !(await ensureTerminalProfileTrust({
          id: profile.id,
          name: profile.name,
          command: tab.launchCommand,
        }))
      ) {
        return
      }
    }
    if (!options?.preserveOutput) {
      clearTerminalOutput(id)
    } else {
      // Keep scrollback/history while resetting the partial input accumulator.
      terminalInputPending.delete(id)
    }
    clearPtySpawnFallback(id)
    ptySpawnInFlight.delete(id)
    markIntentionalPtyKill(id)
    try {
      await killTerminal(id)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', translate('结束终端进程失败: {error}', { error: String(error) }))
    }
    set(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id
          ? {
              ...terminal,
              status: 'starting',
              exitCode: null,
              startedAt: Date.now(),
              awaitingRestoreSpawn: false,
              restorePreservedOutput: options?.preserveOutput === true,
              ptySpawnPending: true,
            }
          : terminal
      ),
    }))
    useUIStore.getState().openTerminalPanel()
    const remembered = lastPtySize.get(id)
    schedulePtySpawnFallback(id, () => {
      void get().spawnPendingTerminal(
        id,
        remembered?.cols ?? DEFAULT_PTY_COLS,
        remembered?.rows ?? DEFAULT_PTY_ROWS
      )
    })
    // Prefer an immediate respawn when we already know the grid (xterm still mounted).
    if (remembered) {
      void get().spawnPendingTerminal(id, remembered.cols, remembered.rows)
    }
  },

  hydrateTerminalSessions: (terminals, bindings) => {
    const owned = inferTerminalPaneOwnership(terminals, bindings)
    set({
      terminals: owned,
      activeTerminalId: null,
      secondaryTerminalId: null,
      blTerminalId: null,
      brTerminalId: null,
      activeTerminalByProject: { ...bindings.activeTerminalByProject },
      secondaryTerminalByProject: { ...(bindings.secondaryTerminalByProject ?? {}) },
      blTerminalByProject: { ...(bindings.blTerminalByProject ?? {}) },
      brTerminalByProject: { ...(bindings.brTerminalByProject ?? {}) },
    })
    hydrateTerminalOutputForTabs(owned.map(t => t.id))
  },

  replaceTerminalSessionsForProjects: async (projectIds, terminals, bindings) => {
    const replace = new Set(projectIds)
    if (replace.size === 0) return
    const outgoing = get()
      .terminals.filter(t => replace.has(t.projectId))
      .map(t => t.id)
    for (const id of outgoing) markIntentionalPtyKill(id)
    await Promise.all(outgoing.map(id => killTerminal(id).catch(() => undefined)))
    outgoing.forEach(id => clearTerminalOutput(id))
    set(s => {
      const kept = s.terminals.filter(t => !replace.has(t.projectId))
      const nextActiveByProject = { ...s.activeTerminalByProject }
      const nextSecondaryByProject = { ...s.secondaryTerminalByProject }
      const nextBlByProject = { ...s.blTerminalByProject }
      const nextBrByProject = { ...s.brTerminalByProject }
      for (const id of replace) {
        delete nextActiveByProject[id]
        delete nextSecondaryByProject[id]
        delete nextBlByProject[id]
        delete nextBrByProject[id]
      }
      for (const [projectId, terminalId] of Object.entries(bindings.activeTerminalByProject)) {
        if (replace.has(projectId)) nextActiveByProject[projectId] = terminalId
      }
      for (const [projectId, terminalId] of Object.entries(
        bindings.secondaryTerminalByProject ?? {}
      )) {
        if (replace.has(projectId)) nextSecondaryByProject[projectId] = terminalId
      }
      for (const [projectId, terminalId] of Object.entries(bindings.blTerminalByProject ?? {})) {
        if (replace.has(projectId)) nextBlByProject[projectId] = terminalId
      }
      for (const [projectId, terminalId] of Object.entries(bindings.brTerminalByProject ?? {})) {
        if (replace.has(projectId)) nextBrByProject[projectId] = terminalId
      }
      const nextTerminals = inferTerminalPaneOwnership([...kept, ...terminals], {
        activeTerminalByProject: nextActiveByProject,
        secondaryTerminalByProject: nextSecondaryByProject,
        blTerminalByProject: nextBlByProject,
        brTerminalByProject: nextBrByProject,
      })
      const activeTerminalId =
        s.activeTerminalId && nextTerminals.some(t => t.id === s.activeTerminalId)
          ? s.activeTerminalId
          : null
      const secondaryTerminalId =
        s.secondaryTerminalId && nextTerminals.some(t => t.id === s.secondaryTerminalId)
          ? s.secondaryTerminalId
          : null
      const blTerminalId =
        s.blTerminalId && nextTerminals.some(t => t.id === s.blTerminalId) ? s.blTerminalId : null
      const brTerminalId =
        s.brTerminalId && nextTerminals.some(t => t.id === s.brTerminalId) ? s.brTerminalId : null
      return {
        terminals: nextTerminals,
        activeTerminalByProject: nextActiveByProject,
        secondaryTerminalByProject: nextSecondaryByProject,
        blTerminalByProject: nextBlByProject,
        brTerminalByProject: nextBrByProject,
        activeTerminalId,
        secondaryTerminalId,
        blTerminalId,
        brTerminalId,
      }
    })
    hydrateTerminalOutputForTabs(terminals.map(t => t.id))
  },

  spawnRestoredTerminals: async (projectId: string) => {
    const pending = get().terminals.filter(
      t => t.projectId === projectId && t.awaitingRestoreSpawn && !restoreSpawnInFlight.has(t.id)
    )
    if (pending.length === 0) return
    for (const t of pending) restoreSpawnInFlight.add(t.id)
    try {
      // Keep awaitingRestoreSpawn until restartTerminal flips status to
      // starting — otherwise run-config UI briefly treats tabs as idle.
      // Preserve scrollback across restore respawn (manual restart still clears).
      await Promise.all(pending.map(t => get().restartTerminal(t.id, { preserveOutput: true })))
    } finally {
      for (const t of pending) restoreSpawnInFlight.delete(t.id)
    }
  },

  activateProject: (projectId: string) =>
    set(s => {
      const projectTerminals = s.terminals.filter(terminal => terminal.projectId === projectId)
      const owned = (pane: TerminalFocusPane) =>
        projectTerminals.filter(t => terminalPaneOf(t) === pane)

      const pickOwned = (
        pane: TerminalFocusPane,
        rememberedId: string | undefined,
      ): string | null => {
        const list = owned(pane)
        if (rememberedId && list.some(t => t.id === rememberedId)) return rememberedId
        return list[0]?.id ?? null
      }

      const activeTerminalId = pickOwned('primary', s.activeTerminalByProject[projectId])
      const secondaryTerminalId = pickOwned(
        'secondary',
        s.secondaryTerminalByProject[projectId],
      )
      const blTerminalId = pickOwned('bl', s.blTerminalByProject[projectId])
      const brTerminalId = pickOwned('br', s.brTerminalByProject[projectId])

      const activeTerminalByProject = { ...s.activeTerminalByProject }
      const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
      const blTerminalByProject = { ...s.blTerminalByProject }
      const brTerminalByProject = { ...s.brTerminalByProject }
      if (activeTerminalId) activeTerminalByProject[projectId] = activeTerminalId
      else delete activeTerminalByProject[projectId]
      if (secondaryTerminalId) secondaryTerminalByProject[projectId] = secondaryTerminalId
      else delete secondaryTerminalByProject[projectId]
      if (blTerminalId) blTerminalByProject[projectId] = blTerminalId
      else delete blTerminalByProject[projectId]
      if (brTerminalId) brTerminalByProject[projectId] = brTerminalId
      else delete brTerminalByProject[projectId]

      return {
        activeTerminalId,
        activeTerminalByProject,
        secondaryTerminalId,
        secondaryTerminalByProject,
        blTerminalId,
        blTerminalByProject,
        brTerminalId,
        brTerminalByProject,
        terminalFocusPane: 'primary' as const,
      }
    }),

  updateProjectPath: (projectId: string, path: string) =>
    set(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.projectId === projectId ? { ...terminal, cwd: path } : terminal
      ),
    })),

  setActiveTerminal: (id: string) =>
    set(s => {
      const terminal = s.terminals.find(tab => tab.id === id)
      if (!terminal) return s
      // Activate inside the session's home pane — never steal into the focus pane.
      const pane = terminalPaneOf(terminal)
      return {
        terminalFocusPane: pane,
        ...bindTerminalToPane(s, terminal.projectId, pane, id),
      }
    }),

  setTerminalFocusPane: pane => set({ terminalFocusPane: pane }),

  setSecondaryTerminal: id =>
    set(s => {
      if (id == null) {
        const projectId = useProjectStore.getState().currentProject?.id
        const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
        if (projectId) delete secondaryTerminalByProject[projectId]
        return { secondaryTerminalId: null, secondaryTerminalByProject }
      }
      const terminal = s.terminals.find(tab => tab.id === id)
      if (!terminal || terminalPaneOf(terminal) !== 'secondary') return s
      return {
        secondaryTerminalId: id,
        secondaryTerminalByProject: {
          ...s.secondaryTerminalByProject,
          [terminal.projectId]: id,
        },
      }
    }),

  ensureSecondaryTerminal: projectId =>
    set(s => {
      const terminals = inferTerminalPaneOwnership(s.terminals, {
        activeTerminalByProject: s.activeTerminalByProject,
        secondaryTerminalByProject: s.secondaryTerminalByProject,
        blTerminalByProject: s.blTerminalByProject,
        brTerminalByProject: s.brTerminalByProject,
      })
      const owned = terminals.filter(
        t => t.projectId === projectId && terminalPaneOf(t) === 'secondary',
      )
      const current = s.secondaryTerminalId
      const next =
        current && owned.some(t => t.id === current) ? current : owned[0]?.id ?? null
      const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
      if (next) secondaryTerminalByProject[projectId] = next
      else delete secondaryTerminalByProject[projectId]
      if (
        next === s.secondaryTerminalId &&
        terminals === s.terminals &&
        secondaryTerminalByProject[projectId] === s.secondaryTerminalByProject[projectId]
      ) {
        return s
      }
      return {
        terminals,
        secondaryTerminalId: next,
        secondaryTerminalByProject,
      }
    }),

  ensureQuadTerminals: projectId =>
    set(s => {
      const terminals = inferTerminalPaneOwnership(s.terminals, {
        activeTerminalByProject: s.activeTerminalByProject,
        secondaryTerminalByProject: s.secondaryTerminalByProject,
        blTerminalByProject: s.blTerminalByProject,
        brTerminalByProject: s.brTerminalByProject,
      })
      const owned = (pane: TerminalFocusPane) =>
        terminals.filter(t => t.projectId === projectId && terminalPaneOf(t) === pane)

      const resolve = (pane: TerminalFocusPane, current: string | null) => {
        const list = owned(pane)
        if (current && list.some(t => t.id === current)) return current
        return list[0]?.id ?? null
      }

      const activeTerminalId = resolve('primary', s.activeTerminalId)
      const secondaryTerminalId = resolve('secondary', s.secondaryTerminalId)
      const blTerminalId = resolve('bl', s.blTerminalId)
      const brTerminalId = resolve('br', s.brTerminalId)

      const activeTerminalByProject = { ...s.activeTerminalByProject }
      const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
      const blTerminalByProject = { ...s.blTerminalByProject }
      const brTerminalByProject = { ...s.brTerminalByProject }
      if (activeTerminalId) activeTerminalByProject[projectId] = activeTerminalId
      else delete activeTerminalByProject[projectId]
      if (secondaryTerminalId) secondaryTerminalByProject[projectId] = secondaryTerminalId
      else delete secondaryTerminalByProject[projectId]
      if (blTerminalId) blTerminalByProject[projectId] = blTerminalId
      else delete blTerminalByProject[projectId]
      if (brTerminalId) brTerminalByProject[projectId] = brTerminalId
      else delete brTerminalByProject[projectId]

      return {
        terminals,
        activeTerminalId,
        activeTerminalByProject,
        secondaryTerminalId,
        secondaryTerminalByProject,
        blTerminalId,
        blTerminalByProject,
        brTerminalId,
        brTerminalByProject,
      }
    }),

  paneTerminalId: pane => readPaneTerminalId(get(), pane),

  focusedTerminalId: () => {
    const s = get()
    const focused = readPaneTerminalId(s, s.terminalFocusPane)
    return focused ?? s.activeTerminalId
  },

  writeToTerminal: async (id: string, data: string) => {
    recordTypedInput(id, data)
    try {
      await writeTerminal(id, data)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', translate('终端输入失败: {error}', { error: String(error) }))
    }
  },

  resizeTerminal: async (id: string, cols: number, rows: number) => {
    const size = normalizePtySize(cols, rows)
    rememberPtySize(id, size.cols, size.rows)
    try {
      await resizeTerminal(id, size.cols, size.rows)
    } catch (error) {
      console.warn('resize_terminal failed:', error)
    }
  },

  spawnPendingTerminal: async (id: string, cols: number, rows: number) => {
    const tab = get().terminals.find(terminal => terminal.id === id)
    if (!tab?.ptySpawnPending) return
    if (ptySpawnInFlight.has(id)) return
    ptySpawnInFlight.add(id)
    clearPtySpawnFallback(id)
    const size = normalizePtySize(cols, rows)
    rememberPtySize(id, size.cols, size.rows)
    // Clear pending before await so concurrent fit callbacks do not double-spawn.
    set(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id ? { ...terminal, ptySpawnPending: false } : terminal
      ),
    }))
    try {
      const plan = planTerminalSpawn(tab)
      let spawnResult: TerminalSpawnResult | undefined
      if (plan.mode === 'script') {
        spawnResult = await spawnTerminalScript({
          id,
          cwd: tab.cwd,
          shellKind: plan.shellKind,
          target: plan.target,
          env: plan.env,
          cols: size.cols,
          rows: size.rows,
        })
      } else if (plan.mode === 'interactive') {
        // Profiles (e.g. OpenCode): one path — run command, keep shell via -NoExit.
        spawnResult = await spawnTerminalScript({
          id,
          cwd: tab.cwd,
          shellKind: 'interactive',
          target: plan.command,
          env: tab.env ?? {},
          cols: size.cols,
          rows: size.rows,
          shell: tab.shell ?? null,
        })
      } else {
        spawnResult = await createTerminal({
          id,
          cwd: tab.cwd,
          cols: size.cols,
          rows: size.rows,
          shell: tab.shell ?? null,
        })
      }
      applyTerminalSpawnResult(id, spawnResult)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id && terminal.status === 'starting'
            ? { ...terminal, status: 'running', restorePreservedOutput: undefined }
            : terminal
        ),
      }))
    } catch (e) {
      console.error('spawnPendingTerminal failed:', e)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id
            ? {
                ...terminal,
                status: 'exited',
                exitCode: null,
                restorePreservedOutput: undefined,
                ptySpawnPending: false,
              }
            : terminal
        ),
      }))
      useProjectStore.getState().pushToast('error', `新建终端失败: ${String(e)}`)
    } finally {
      ptySpawnInFlight.delete(id)
    }
  },

  renameTerminal: (id, name) =>
    set(s => ({
      terminals: s.terminals.map(t => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
    })),

  initializeTerminalEvents: async () => {
    const [unlistenData, unlistenExit] = await Promise.all([
      listen<{ id: string; data: number[] }>('terminal-data', event => {
        if (get().terminals.some(terminal => terminal.id === event.payload.id)) {
          publishTerminalOutput(event.payload.id, event.payload.data)
        }
      }),
      listen<{ id: string; exit_code: number }>('terminal-exit', event => {
        const { id, exit_code } = event.payload
        clearTerminalCommandActivity(id)
        const tab = get().terminals.find(t => t.id === id)
        if (!tab) {
          consumeIntentionalPtyKill(id)
          return
        }
        // close / restart / replace — do not treat as a soft shell death.
        if (consumeIntentionalPtyKill(id)) {
          if (tab.ptySpawnPending || tab.status === 'starting') return
          set(s => ({
            terminals: s.terminals.map(terminal =>
              terminal.id === id ? { ...terminal, status: 'exited', exitCode: exit_code } : terminal
            ),
          }))
          return
        }
        // OpenCode etc. often kill the whole ConPTY; reopen a shell so the
        // user can keep typing instead of seeing「进程已退出」.
        if (shouldKeepShellAfterExit(tab)) {
          void respawnShellAfterExit(id)
          return
        }
        const startedAt = tab.startedAt
        const quickFail =
          !!startedAt && Date.now() - startedAt < QUICK_FAIL_THRESHOLD_MS && exit_code !== 0
        set(s => ({
          terminals: s.terminals.map(terminal =>
            terminal.id === id
              ? {
                  ...terminal,
                  status: 'exited',
                  exitCode: exit_code,
                }
              : terminal
          ),
        }))
        if (quickFail) {
          // 进程秒退且非零退出：切到该终端并提示，便于直接看到报错。
          useUIStore.getState().openTerminalPanel()
          get().setActiveTerminal(id)
          useProjectStore
            .getState()
            .pushToast(
              'error',
              `「${terminalDisplayLabel(tab.name)}」启动失败（退出码 ${exit_code}）`,
              '已切换到该终端，请查看输出中的错误信息'
            )
        }
      }),
    ])

    return () => {
      unlistenData()
      unlistenExit()
    }
  },
}))

// Durable terminal metadata is persisted via workspaceSessionSync (localStorage).
// Scrollback / command history is persisted separately (terminalSessionPersist).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    persistTerminalOutputNow()
  })
}

/** True when the ring still has bytes (used by Terminal UI for restore banners). */
export function hasTerminalScrollback(id: string): boolean {
  const ring = terminalScrollbackRings.get(id)
  return !!ring && ring.byteLength > 0
}
