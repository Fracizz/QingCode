import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { safeInvoke } from '../lib/tauri'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'
import type { TerminalTab } from '../types'
import {
  DEFAULT_TERMINAL_PROFILE,
  getTerminalProfile,
  loadTerminalProfileSettings,
} from '../lib/terminalProfiles'
import { ensureTerminalProfileTrust } from '../lib/terminalProfileTrust'
import { isProjectTrusted } from '../lib/workspaceTrust'
import { disambiguateTerminalName, resolveNewTerminalName, terminalDisplayLabel } from '../utils/terminalName'
import { translate } from '../lib/i18n'
import {
  getTerminalScrollback,
  scrollbackMaxChars,
} from '../lib/terminalScrollbackSettings'
import {
  absorbInputForHistory,
  appendScrollbackBytes,
  buildTerminalOutputSnapshot,
  decodeScrollbackBytes,
  encodeScrollbackText,
  loadTerminalOutputSnapshot,
  pushCommandHistory,
  saveTerminalOutputSnapshot,
  truncateScrollbackBytes,
} from '../lib/terminalSessionPersist'
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  normalizePtySize,
} from '../lib/terminalPtySize'
import { shouldKeepShellAfterExit } from '../lib/terminalShellLifecycle'
import { planTerminalSpawn } from '../lib/terminalSpawnPlan'
import {
  effectiveShellForTerminalName,
  isTerminalShellId,
  normalizeTerminalShell,
  terminalShellLabelKey,
  type TerminalShellId,
} from '../lib/terminalShell'
import { clearTerminalCommandActivity } from '../lib/terminalCommandActivity'
import { isSessionPersistEnabled } from '../lib/sessionPersistSettings'

export const MAX_TERMINALS_PER_PROJECT = 10
/** @deprecated Cleared on boot; durable metadata lives in workspaceSessionPersist. */
const LEGACY_SESSION_STORAGE_KEY = 'qingcode:terminal-layout'
const OUTPUT_PERSIST_DEBOUNCE_MS = 800

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

type TerminalSpawnResult = {
  resolvedShell?: unknown
  fallbackFrom?: unknown
}

function isGeneratedShellName(tab: TerminalTab): boolean {
  if (/^(终端|Terminal) \d+$/.test(tab.name)) return true
  const shellIds = [tab.shell, tab.resolvedShell].filter(
    (shell): shell is TerminalShellId => shell !== undefined,
  )
  return shellIds.some(shell => {
    const label = translate(terminalShellLabelKey(shell))
    return tab.name === label || tab.name.startsWith(`${label} (`)
  })
}

function applyTerminalSpawnResult(id: string, result: TerminalSpawnResult | null | undefined) {
  const resolvedShell = isTerminalShellId(result?.resolvedShell)
    ? result.resolvedShell
    : undefined
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
          state.terminals.filter(terminal => terminal.id !== id).map(terminal => terminal.name),
        )
      }
      return {
        terminals: state.terminals.map(terminal =>
          terminal.id === id ? { ...terminal, name, resolvedShell } : terminal
        ),
      }
    })
  }

  const fallbackFrom = isTerminalShellId(result?.fallbackFrom)
    ? result.fallbackFrom
    : undefined
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
    }, PTY_SPAWN_FALLBACK_MS),
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
    const result = await safeInvoke<TerminalSpawnResult>('新建终端', 'create_terminal', {
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
        terminal.id === id
          ? { ...terminal, status: 'exited', exitCode: null }
          : terminal
      ),
    }))
  } finally {
    ptySpawnInFlight.delete(id)
  }
}

/** Late-subscriber catch-up (cleared once a live listener attaches). */
const terminalOutputBuffers = new Map<string, Uint8Array>()
/** Always-on ring used for persistence + restore replay. */
const terminalScrollbackRings = new Map<string, Uint8Array>()
const terminalCommandHistory = new Map<string, string[]>()
const terminalInputPending = new Map<string, string>()
const terminalOutputListeners = new Map<string, Set<TerminalOutputListener>>()
const terminalRingUpdatedAt = new Map<string, number>()

let outputPersistTimer: ReturnType<typeof setTimeout> | null = null

function maxBufferedBytes(): number {
  return scrollbackMaxChars(getTerminalScrollback())
}

function touchRing(id: string, bytes: Uint8Array) {
  terminalScrollbackRings.set(id, bytes)
  terminalRingUpdatedAt.set(id, Date.now())
  scheduleTerminalOutputPersist()
}

function publishTerminalOutput(id: string, data: number[]) {
  const bytes = new Uint8Array(data)
  const ring = appendScrollbackBytes(
    terminalScrollbackRings.get(id),
    bytes,
    getTerminalScrollback(),
    maxBufferedBytes(),
  )
  touchRing(id, ring)

  const listeners = terminalOutputListeners.get(id)
  if (listeners?.size) {
    listeners.forEach(listener => listener(bytes))
    return
  }

  const previous = terminalOutputBuffers.get(id)
  const buffered = appendScrollbackBytes(
    previous,
    bytes,
    getTerminalScrollback(),
    maxBufferedBytes(),
  )
  terminalOutputBuffers.set(id, buffered)
}

function clearTerminalOutput(id: string, options?: { persist?: boolean }) {
  terminalOutputBuffers.delete(id)
  terminalScrollbackRings.delete(id)
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
  history: string[] = [],
) {
  if (scrollback) {
    const bytes = truncateScrollbackBytes(
      encodeScrollbackText(scrollback),
      getTerminalScrollback(),
      maxBufferedBytes(),
    )
    terminalScrollbackRings.set(id, bytes)
    terminalOutputBuffers.set(id, bytes)
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
  const listeners = terminalOutputListeners.get(id) ?? new Set<TerminalOutputListener>()
  listeners.add(listener)
  terminalOutputListeners.set(id, listeners)

  const buffered = terminalOutputBuffers.get(id)
  if (buffered) {
    terminalOutputBuffers.delete(id)
    listener(buffered)
  } else {
    // Remount after project switch: replay the durable ring once.
    const ring = terminalScrollbackRings.get(id)
    if (ring?.length && listeners.size === 1) {
      listener(ring)
    }
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) terminalOutputListeners.delete(id)
  }
}

function collectOutputPersistPayload(): Record<
  string,
  { scrollback: string; history: string[]; updatedAt?: number }
> {
  const terminals: Record<string, { scrollback: string; history: string[]; updatedAt?: number }> =
    {}
  for (const tab of useTerminalStore.getState().terminals) {
    const scrollback = decodeScrollbackBytes(terminalScrollbackRings.get(tab.id))
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
  if (!isSessionPersistEnabled()) return
  const terminals = collectOutputPersistPayload()
  const snapshot = buildTerminalOutputSnapshot({
    terminals,
    scrollbackLines: getTerminalScrollback(),
  })
  saveTerminalOutputSnapshot(snapshot)
}

export function scheduleTerminalOutputPersist() {
  if (outputPersistTimer) clearTimeout(outputPersistTimer)
  outputPersistTimer = setTimeout(() => {
    outputPersistTimer = null
    persistTerminalOutputNow()
  }, OUTPUT_PERSIST_DEBOUNCE_MS)
}

function recordTypedInput(id: string, data: string) {
  const { pending, commands } = absorbInputForHistory(
    terminalInputPending.get(id) ?? '',
    data,
  )
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

interface TerminalState {
  terminals: TerminalTab[]
  activeTerminalId: string | null
  activeTerminalByProject: Record<string, string>
  addTerminal: (projectPath: string, projectId: string, profileId?: string) => Promise<string | null>
  addScriptTerminal: (
    projectId: string,
    cwd: string,
    shellKind: ShellKind,
    target: string,
    env: Record<string, string>,
    name: string,
    linkage?: { runConfigId: string; runTaskId: string },
  ) => Promise<string | null>
  closeTerminal: (id: string) => Promise<void>
  closeOtherTerminals: (id: string) => Promise<void>
  closeAllProjectTerminals: (projectId: string) => Promise<void>
  closeProjectTerminals: (projectId: string) => Promise<void>
  restartTerminal: (id: string, options?: { preserveOutput?: boolean }) => Promise<void>
  /** Seed tabs from durable workspace session (no PTY yet). */
  hydrateTerminalSessions: (
    terminals: TerminalTab[],
    activeTerminalByProject: Record<string, string>,
  ) => void
  /**
   * Replace terminal metadata for specific projects (named workspace restore).
   * Other projects' terminals are left alone. Kills PTYs for replaced ids.
   */
  replaceTerminalSessionsForProjects: (
    projectIds: string[],
    terminals: TerminalTab[],
    activeTerminalByProject: Record<string, string>,
  ) => Promise<void>
  /** Spawn PTYs for tabs restored after restart (once). */
  spawnRestoredTerminals: (projectId: string) => Promise<void>
  activateProject: (projectId: string) => void
  updateProjectPath: (projectId: string, path: string) => void
  setActiveTerminal: (id: string) => void
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

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: null,
  activeTerminalByProject: {},

  addTerminal: async (projectPath: string, projectId: string, profileId?: string) => {
    const project =
      useProjectStore.getState().projects.find(p => p.id === projectId) ??
      (useProjectStore.getState().currentProject?.id === projectId
        ? useProjectStore.getState().currentProject
        : null)
    if (project && !project.ephemeral && !isProjectTrusted(project)) {
      useProjectStore
        .getState()
        .pushToast('info', translate('当前为受限模式，无法打开终端'))
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
      shellLabel,
    )
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
      // OSC titles rename the tab (cwd / apps); generic shell noise is filtered in UI.
      allowTitleRename: true,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      ptySpawnPending: true,
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      activeTerminalId: id,
      activeTerminalByProject: { ...s.activeTerminalByProject, [projectId]: id },
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
    linkage?,
  ) => {
    const project =
      useProjectStore.getState().projects.find(p => p.id === projectId) ??
      (useProjectStore.getState().currentProject?.id === projectId
        ? useProjectStore.getState().currentProject
        : null)
    if (project && !project.ephemeral && !isProjectTrusted(project)) {
      useProjectStore
        .getState()
        .pushToast('info', translate('当前为受限模式，无法运行任务'))
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
    const tab: TerminalTab = {
      id,
      name,
      projectId,
      cwd,
      launchCommand: target,
      shellKind,
      env,
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
      activeTerminalId: id,
      activeTerminalByProject: { ...s.activeTerminalByProject, [projectId]: id },
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
    try {
      await safeInvoke('关闭终端', 'kill_terminal', { id })
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast(
          'error',
          translate('关闭终端失败: {error}', { error: String(error) }),
        )
    }
    set(s => {
      const closed = s.terminals.find(t => t.id === id)
      const terminals = s.terminals.filter(t => t.id !== id)
      if (!closed) return { terminals }
      const projectTerminals = terminals.filter(t => t.projectId === closed.projectId)
      const nextProjectActive = projectTerminals[projectTerminals.length - 1]?.id
      const activeTerminalByProject = { ...s.activeTerminalByProject }
      if (nextProjectActive) activeTerminalByProject[closed.projectId] = nextProjectActive
      else delete activeTerminalByProject[closed.projectId]
      const activeTerminalId =
        s.activeTerminalId === id
          ? nextProjectActive ?? null
          : s.activeTerminalId
      return { terminals, activeTerminalId, activeTerminalByProject }
    })
    clearTerminalOutput(id)
  },

  closeOtherTerminals: async (id: string) => {
    const keep = get().terminals.find(t => t.id === id)
    if (!keep) return
    const others = get()
      .terminals.filter(t => t.projectId === keep.projectId && t.id !== id)
      .map(t => t.id)
    for (const tid of others) {
      clearPtySpawnFallback(tid)
      ptySpawnInFlight.delete(tid)
      lastPtySize.delete(tid)
      markIntentionalPtyKill(tid)
    }
    await Promise.all(
      others.map(tid => safeInvoke('关闭终端', 'kill_terminal', { id: tid }).catch(() => undefined))
    )
    set(s => {
      const terminals = s.terminals.filter(t => !(t.projectId === keep.projectId && t.id !== id))
      const activeTerminalByProject = { ...s.activeTerminalByProject }
      activeTerminalByProject[keep.projectId] = id
      return { terminals, activeTerminalId: id, activeTerminalByProject }
    })
    others.forEach(id => clearTerminalOutput(id))
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
    await Promise.all(
      ids.map(id => safeInvoke('关闭终端', 'kill_terminal', { id }).catch(() => undefined))
    )
    set(s => {
      const activeTerminalByProject = { ...s.activeTerminalByProject }
      delete activeTerminalByProject[projectId]
      return {
        terminals: s.terminals.filter(t => t.projectId !== projectId),
        activeTerminalId: ids.includes(s.activeTerminalId ?? '') ? null : s.activeTerminalId,
        activeTerminalByProject,
      }
    })
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
    await Promise.all(
      ids.map(id => safeInvoke('关闭终端', 'kill_terminal', { id }).catch(() => undefined))
    )
    set(s => {
      const activeTerminalByProject = { ...s.activeTerminalByProject }
      delete activeTerminalByProject[projectId]
      return {
        terminals: s.terminals.filter(terminal => terminal.projectId !== projectId),
        activeTerminalId: ids.includes(s.activeTerminalId ?? '') ? null : s.activeTerminalId,
        activeTerminalByProject,
      }
    })
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
      // Keep scrollback/history; drop late-subscriber catch-up so xterm is not double-fed.
      terminalOutputBuffers.delete(id)
      terminalInputPending.delete(id)
    }
    clearPtySpawnFallback(id)
    ptySpawnInFlight.delete(id)
    markIntentionalPtyKill(id)
    try {
      await safeInvoke('关闭终端', 'kill_terminal', { id })
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast(
          'error',
          translate('结束终端进程失败: {error}', { error: String(error) }),
        )
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
        remembered?.rows ?? DEFAULT_PTY_ROWS,
      )
    })
    // Prefer an immediate respawn when we already know the grid (xterm still mounted).
    if (remembered) {
      void get().spawnPendingTerminal(id, remembered.cols, remembered.rows)
    }
  },

  hydrateTerminalSessions: (terminals, activeTerminalByProject) => {
    set({
      terminals,
      activeTerminalId: null,
      activeTerminalByProject: { ...activeTerminalByProject },
    })
    hydrateTerminalOutputForTabs(terminals.map(t => t.id))
  },

  replaceTerminalSessionsForProjects: async (
    projectIds,
    terminals,
    activeTerminalByProject,
  ) => {
    const replace = new Set(projectIds)
    if (replace.size === 0) return
    const outgoing = get()
      .terminals.filter(t => replace.has(t.projectId))
      .map(t => t.id)
    for (const id of outgoing) markIntentionalPtyKill(id)
    await Promise.all(
      outgoing.map(id => safeInvoke('关闭终端', 'kill_terminal', { id }).catch(() => undefined)),
    )
    outgoing.forEach(id => clearTerminalOutput(id))
    set(s => {
      const kept = s.terminals.filter(t => !replace.has(t.projectId))
      const nextActiveByProject = { ...s.activeTerminalByProject }
      for (const id of replace) delete nextActiveByProject[id]
      for (const [projectId, terminalId] of Object.entries(activeTerminalByProject)) {
        if (replace.has(projectId)) nextActiveByProject[projectId] = terminalId
      }
      const nextTerminals = [...kept, ...terminals]
      const activeTerminalId =
        s.activeTerminalId && nextTerminals.some(t => t.id === s.activeTerminalId)
          ? s.activeTerminalId
          : null
      return {
        terminals: nextTerminals,
        activeTerminalByProject: nextActiveByProject,
        activeTerminalId,
      }
    })
    hydrateTerminalOutputForTabs(terminals.map(t => t.id))
  },

  spawnRestoredTerminals: async (projectId: string) => {
    const pending = get().terminals.filter(
      t => t.projectId === projectId && t.awaitingRestoreSpawn && !restoreSpawnInFlight.has(t.id),
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
    // Maps may have been empty before spawn (or linkage stamped later); refresh.
    const { rehydrateRunningFromTerminals } = await import('./runConfigStore')
    rehydrateRunningFromTerminals()
  },

  activateProject: (projectId: string) =>
    set(s => {
      const projectTerminals = s.terminals.filter(terminal => terminal.projectId === projectId)
      const remembered = s.activeTerminalByProject[projectId]
      const activeTerminalId = projectTerminals.some(terminal => terminal.id === remembered)
        ? remembered
        : projectTerminals[0]?.id ?? null
      return {
        activeTerminalId,
        activeTerminalByProject: activeTerminalId
          ? { ...s.activeTerminalByProject, [projectId]: activeTerminalId }
          : s.activeTerminalByProject,
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
      return {
        activeTerminalId: id,
        activeTerminalByProject: {
          ...s.activeTerminalByProject,
          [terminal.projectId]: id,
        },
      }
    }),

  writeToTerminal: async (id: string, data: string) => {
    recordTypedInput(id, data)
    try {
      await safeInvoke('终端输入', 'write_terminal', { id, data })
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast(
          'error',
          translate('终端输入失败: {error}', { error: String(error) }),
        )
    }
  },

  resizeTerminal: async (id: string, cols: number, rows: number) => {
    const size = normalizePtySize(cols, rows)
    rememberPtySize(id, size.cols, size.rows)
    try {
      await safeInvoke('终端尺寸', 'resize_terminal', {
        id,
        cols: size.cols,
        rows: size.rows,
      })
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
        spawnResult = await safeInvoke<TerminalSpawnResult>('启动任务', 'spawn_script', {
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
        spawnResult = await safeInvoke<TerminalSpawnResult>('启动终端配置', 'spawn_script', {
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
        spawnResult = await safeInvoke<TerminalSpawnResult>('新建终端', 'create_terminal', {
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
              terminal.id === id
                ? { ...terminal, status: 'exited', exitCode: exit_code }
                : terminal
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
          !!startedAt &&
          Date.now() - startedAt < QUICK_FAIL_THRESHOLD_MS &&
          exit_code !== 0
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
          useProjectStore.getState().pushToast(
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
  return !!ring && ring.length > 0
}
