import { localCodexPrewarm } from '../lib/terminal/localCodexPrewarm'
import { connectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { effectiveDefaultProfileIdFor } from '../lib/terminal/connectionDefaultProfile'
import { recordShellOpen } from '../lib/terminal/shellOpenDiagnostics'
import { reservePrewarmedShell } from '../lib/terminal/shellPrewarmSettings'
import { recordTerminalDiagnostic, type TerminalActionSource } from '@/lib/terminal/terminalDiagnostics'
import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  attachTerminal,
  createTerminal,
  killDetachedTerminal,
  killTerminal,
  listDetachedTerminals,
  spawnTerminalScript,
  terminalSessionOpen,
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
  posixSshShellLabelKey,
  windowsSshShellLabel,
} from '../utils/terminalName'
import { translate } from '../lib/i18n'
import { noteTerminalReattached, trackStartupReattach } from '../lib/terminal/terminalReattachNotice'
import { serverModeErrorAction } from '../lib/serverModeError'
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  normalizePtySize,
} from '@/lib/terminal/terminalPtySize'
import {
  parseTerminalExitEvent,
  planTerminalConnectionEvent,
  shouldCancelReconnectOnInput,
  shouldKeepShellAfterExit,
} from '@/lib/terminal/terminalShellLifecycle'
import { planTerminalSpawn } from '@/lib/terminal/terminalSpawnPlan'
import { getTerminalPersistLocalSessions } from '@/lib/terminal/terminalPersistLocalSettings'
import {
  effectiveShellForTerminalName,
  isTerminalShellId,
  normalizeTerminalShell,
  terminalShellLabelKey,
  type TerminalShellId,
} from '@/lib/terminal/terminalShell'
import { clearTerminalCommandActivity } from '@/lib/terminal/terminalCommandActivity'
import {
  clearTerminalProgramActivity,
  getTerminalLastWorkAt,
  getTerminalProgramBusySnapshot,
  noteTerminalInput,
  noteTerminalOutput,
  noteTerminalSubmit,
  subscribeTerminalProgramActivity,
} from '@/lib/terminal/terminalProgramActivity'
import {
  markTerminalAttention,
  noteTerminalBusyChange,
  pruneTerminalAttention,
  syncTerminalsInView,
} from '@/lib/terminal/terminalAttention'
import { activeTerminalOverlayNotice, clearTerminalOverlayNotice, publishTerminalOverlayNotice } from '@/lib/terminal/terminalOverlayNotice'
import { closeMobileView, isMobileTerminalId, openMobileView } from '../lib/ipc/mobileSessions'
import { useTerminalControlStore } from './terminalControlStore'
import { noteHumanTerminalInput } from '../lib/terminal/terminalInputGate'
import { isSshProject, sshConnectionIdFromUri } from '../lib/sshWorkspace'
import { choiceDialog } from './choiceStore'
import { forgetPreservedTerminalName, terminalNameForReattach } from '@/lib/terminal/detachedTerminalNames'
import {
  filterUnownedDetachedTerminals,
  planTerminalRestore,
  type SshDetachedTerminal,
} from '@/lib/terminal/terminalRestorePlan'
import { isTerminalAutoReattachEnabled } from '@/lib/terminalAutoReattachSettings'
import {
  applyTerminalScreen,
  clearTerminalOutput,
  hydrateTerminalOutputForTabs,
  parseTerminalScreenPayload,
  persistTerminalOutputNow,
  publishTerminalOutput,
  recordTypedInput,
  registerTerminalOutputPersistSource,
  terminalInputPending,
  terminalResumeSeqs,
} from './terminal/outputBuffer'
import {
  clearPtySpawnFallback,
  deferPtySync,
  deferredPtySync,
  lastPtySize,
  markPtySizeChanged,
  planDeferredPtySync,
  FAST_PTY_SPAWN_FALLBACK_MS,
  preferredSpawnSize,
  rememberPtySize,
  schedulePtySpawnFallback,
  sendPtySizePaced,
  terminalViewGrids,
} from './terminal/ptySizing'
import { discardSpawnInput, queueSpawnInput, takeSpawnInput } from './terminal/spawnInputQueue'
import {
  bindTerminalInBackground,
  bindTerminalToPane,
  clearClosedFromPanes,
  clearProjectPaneMaps,
  inferTerminalPaneOwnership,
  readPaneTerminalId,
  reorderTerminalTabs,
  TERMINAL_FOCUS_PANES,
  terminalPaneOf,
  type TerminalDropPosition,
  type TerminalFocusPane,
} from './terminal/panes'

// 以下子模块的对外 API 保持从 terminalStore 导出，调用方 import 路径不变。
export {
  captureTerminalForMirror,
  getTerminalRawScrollback,
  hasTerminalScrollback,
  hydrateTerminalOutputForTabs,
  persistTerminalOutputNow,
  seedTerminalOutputFromPersist,
  subscribeTerminalOutput,
  type TerminalViewSnapshot,
} from './terminal/outputBuffer'
export { planDeferredPtySync, setTerminalViewGrid } from './terminal/ptySizing'
export {
  inferTerminalPaneOwnership,
  reorderTerminalTabs,
  TERMINAL_FOCUS_PANES,
  terminalPaneOf,
  type TerminalDropPosition,
  type TerminalFocusPane,
} from './terminal/panes'

export const MAX_TERMINALS_PER_PROJECT = 10
/** @deprecated Cleared on boot; durable metadata lives in workspaceSessionPersist. */
const LEGACY_SESSION_STORAGE_KEY = 'qingcode:terminal-layout'

/** 够"快"才算启动失败：进程在此时长（毫秒）内非零退出，视为秒退并提示。 */
const QUICK_FAIL_THRESHOLD_MS = 2000

const ptySpawnInFlight = new Set<string>()
const mobileViewsOpening = new Set<string>()
let terminalExitInProgress = false
const terminalRestartsInFlight = new Set<string>()

/** Freeze new PTYs and settle those already being created before taking the exit snapshot. */
export async function pauseTerminalSpawnsForExit(): Promise<void> {
  terminalExitInProgress = true
  const deadline = Date.now() + 5000
  while (ptySpawnInFlight.size > 0 || taskShellTransitions.size > 0 || terminalRestartsInFlight.size > 0) {
    if (Date.now() >= deadline) throw new Error(translate('终端仍在启动，请稍后重试退出。'))
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export function resumeTerminalSpawnsAfterExit(): void {
  terminalExitInProgress = false
  for (const tab of useTerminalStore.getState().terminals) {
    if (!tab.ptySpawnPending) continue
    schedulePtySpawnFallback(tab.id, () => {
      const size = preferredSpawnSize(tab.id)
      void useTerminalStore.getState().spawnPendingTerminal(tab.id, size.cols, size.rows)
    })
  }
}

/** Prevents concurrent App effects from double-respawning restored tabs. */
const restoreSpawnInFlight = new Set<string>()
/** Kills from close/restart — do not auto-respawn a shell for these. */
const intentionalPtyKills = new Set<string>()
const reportedShellFallbacks = new Set<string>()
/** 用户在重连期间按 Ctrl+C、正在放弃重连的终端；期间忽略其余键入。 */
const reconnectCancelInFlight = new Set<string>()
/** Ctrl+C on a finished task may only create one replacement shell. */
const taskShellTransitions = new Set<string>()
/** 已由 store 写过断线说明的已退出终端；视图不再追加“进程未启动”。 */
const disconnectNoticeShown = new Set<string>()
/** One detached-terminal query per project/connection during this app session. */
const detachedTerminalSyncs = new Set<string>()

/** 视图挂载或状态变为已退出时调用：返回 true 表示断线说明已写入输出。 */
export function consumeTerminalDisconnectNotice(id: string): boolean {
  return disconnectNoticeShown.delete(id)
}

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

type TerminalSpawnResultCompat = TerminalSpawnResult & {
  persistent?: unknown
  ptyId?: unknown
  connectionId?: unknown
  persistentReason?: unknown
  persistentFallbackReason?: unknown
}

function applyTerminalSpawnResult(
  id: string,
  result: TerminalSpawnResultCompat | null | undefined,
) {
  const persistent = typeof result?.persistent === 'boolean' ? result.persistent : undefined
  const ptyId =
    typeof result?.ptyId === 'string' && result.ptyId.trim()
      ? result.ptyId.trim()
      : undefined
  const connectionId =
    typeof result?.connectionId === 'string' && result.connectionId.trim()
      ? result.connectionId.trim()
      : undefined
  const rawFallbackReason =
    result?.persistentFallbackReason ?? result?.persistentReason
  const persistentFallbackReason =
    typeof rawFallbackReason === 'string' && rawFallbackReason.trim()
      ? rawFallbackReason.trim()
      : undefined
  if (
    persistent !== undefined ||
    ptyId ||
    connectionId ||
    persistentFallbackReason
  ) {
    useTerminalStore.setState(state => ({
      terminals: state.terminals.map(terminal =>
        terminal.id === id
          ? {
              ...terminal,
              ...(persistent === undefined ? {} : { persistent }),
              ...(ptyId ? { ptyId } : {}),
              ...(connectionId
                ? { connectionId }
                : !terminal.connectionId
                  ? {
                      connectionId:
                        sshConnectionIdFromUri(terminal.cwd) ?? terminal.connectionId,
                    }
                  : {}),
              ...(persistent === false ? { ptyId: undefined } : {}),
              ...(persistentFallbackReason ? { persistentFallbackReason } : {}),
            }
          : terminal
      ),
    }))
  }

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

function markIntentionalPtyKill(id: string) {
  intentionalPtyKills.add(id)
}

function consumeIntentionalPtyKill(id: string): boolean {
  if (!intentionalPtyKills.has(id)) return false
  intentionalPtyKills.delete(id)
  return true
}

/** Drop a kill mark once that process is gone, so it cannot lock the next shell. */
function releaseIntentionalPtyKill(id: string) {
  intentionalPtyKills.delete(id)
}

/**
 * 重启与新建同样从预热池领取，条件一致（远端：普通 Shell 或交互式配置；本机：开启可接回）。
 * 运行任务、带额外环境变量的配置和手机终端不领取。预留项改用原标签 id，标签身份不变。
 */
async function reserveShellForRestart(tab: TerminalTab): Promise<TerminalTab['prewarm']> {
  const plan = planTerminalSpawn(tab)
  const remote = tab.cwd.startsWith('ssh://')
  const startup = plan.mode === 'interactive' ? plan.command : ''
  const eligible = plan.mode !== 'script'
    && Object.keys(tab.env ?? {}).length === 0
    && !isMobileTerminalId(tab.id)
    && (remote || getTerminalPersistLocalSessions())
  if (!eligible) return { outcome: 'miss', reason: 'restart' }
  const reservation = await reservePrewarmedShell(tab.cwd, tab.shell ?? null, !!startup, tab.id)
  return 'id' in reservation ? { outcome: 'reserved' } : { outcome: 'miss', reason: reservation.reason }
}

/** Convert a finished one-shot task into a plain terminal without replaying its command. */
async function enterShellAfterTask(id: string): Promise<void> {
  if (terminalExitInProgress) return
  const tab = useTerminalStore.getState().terminals.find(terminal => terminal.id === id)
  if (
    !tab ||
    tab.status !== 'exited' ||
    shouldKeepShellAfterExit(tab) ||
    tab.restoreUnavailable ||
    tab.awaitingRestoreSpawn ||
    tab.ptySpawnPending ||
    ptySpawnInFlight.has(id) ||
    taskShellTransitions.has(id)
  ) {
    return
  }

  taskShellTransitions.add(id)
  try {
    // Restored/stale UI state must never replace a task that is actually still alive.
    const sessionOpen = await terminalSessionOpen(id)
    const state = useTerminalStore.getState()
    if (state.terminals.find(terminal => terminal.id === id) !== tab) return
    if (sessionOpen) {
      useTerminalStore.setState(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id ? { ...terminal, status: 'running', exitCode: null, endedAt: undefined } : terminal
        ),
      }))
      return
    }
    const projects = useProjectStore.getState()
    const owner =
      projects.projects.find(project => project.id === tab.projectId) ??
      (projects.currentProject?.id === tab.projectId ? projects.currentProject : null)
    if (!owner || (!owner.ephemeral && !isProjectTrusted(owner))) {
      projects.pushToast('info', translate('当前为受限模式，无法打开终端'))
      return
    }

    // Clear task metadata before restarting: spawn, runtime status and persisted
    // session restore must all see a plain shell, never the original task.
    useTerminalStore.setState(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id
          ? {
              ...terminal,
              name: translate('{name} · 命令行', { name: terminal.name }),
              launchCommand: '',
              shellKind: undefined,
              // Use the ordinary shell preference, without a profile startup command.
              shell: tab.shell ?? loadTerminalProfileSettings().defaultShell,
              resolvedShell: undefined,
              env: undefined,
              profileId: undefined,
              runConfigId: undefined,
              runTaskId: undefined,
              persistent: undefined,
              ptyId: undefined,
              persistentFallbackReason: undefined,
              disconnectReason: undefined,
              connectionAttempt: undefined,
              allowTitleRename: true,
            }
          : terminal
      ),
    }))
    await useTerminalStore.getState().restartTerminal(id, { preserveOutput: true })
  } catch (error) {
    useProjectStore.getState().pushToast('error', translate('进入命令行失败: {error}', {
      error: String(error),
    }))
  } finally {
    taskShellTransitions.delete(id)
  }
}

/**
 * 写进终端缓冲的提示：只用于进程已结束等不会再有 TUI 重绘的场景，
 * 同时作为输出证据随滚动历史保留。
 */
function publishTerminalNotice(id: string, text: string) {
  clearTerminalOverlayNotice(id)
  publishTerminalOutput(id, new TextEncoder().encode(`\r\n\x1b[90m[${text}]\x1b[0m\r\n`))
}

/**
 * 断线/重连/已接回等连接提示：前台程序可能仍在运行（常是全屏或行内 TUI），
 * 写进缓冲会盖住并打乱其画面，改由终端视图以浮层显示。
 */
function publishTerminalConnectionNotice(id: string, text: string, sticky: boolean) {
  publishTerminalOverlayNotice(id, text, { sticky })
}

function markDisconnectedExit(id: string) {
  clearTerminalOverlayNotice(id)
  disconnectNoticeShown.add(id)
  useTerminalStore.setState(s => ({
    terminals: s.terminals.map(terminal =>
      terminal.id === id ? { ...terminal, status: 'exited', exitCode: null, endedAt: Date.now() } : terminal
    ),
  }))
}

async function killTerminalForClose(tab: TerminalTab, spawnInFlight: boolean, source: TerminalActionSource = 'user_close'): Promise<void> {
  // 手机终端的标签只是查看入口：关闭标签不结束手机上的进程。
  if (isMobileTerminalId(tab.id)) {
    await closeMobileView(tab.id)
    return
  }
  const operationId = crypto.randomUUID()
  recordTerminalDiagnostic('terminal.close_requested', tab, source, operationId)
  if (tab.awaitingRestoreSpawn && tab.persistent && tab.ptyId && !spawnInFlight) {
    await killDetachedTerminal({ ptyId: tab.ptyId, cwd: tab.cwd })
  } else if (!tab.awaitingRestoreSpawn) {
    await killTerminal(tab.id, source, operationId)
  }
}

/**
 * 重连期间按 Ctrl+C：放弃重连并结束该终端，标签停在已退出，可从标签重启。
 * server 模式会话要等后端关闭（会尽力结束远端进程）后再标记退出，
 * 否则视图查询会话仍开着，会把标签又翻回运行中。
 */
async function cancelTerminalReconnect(id: string): Promise<void> {
  if (reconnectCancelInFlight.has(id)) return
  const tab = useTerminalStore.getState().terminals.find(terminal => terminal.id === id)
  if (!tab) return
  reconnectCancelInFlight.add(id)
  publishTerminalConnectionNotice(id, translate('已取消重新连接，正在结束终端…'), true)
  try {
    if (tab.status === 'reconnecting') {
      try {
        await killTerminal(id, 'cancel_reconnect')
      } catch (error) {
        console.warn(`cancel reconnect kill ${id} failed:`, error)
      }
    }
    const latest = useTerminalStore.getState().terminals.find(terminal => terminal.id === id)
    if (!latest || latest.status === 'exited') return
    publishTerminalNotice(id, translate('已退出，可从终端标签重启'))
    // 直连 SSH 的退避循环看到状态不再是 starting 就会自行停止。
    markDisconnectedExit(id)
  } finally {
    reconnectCancelInFlight.delete(id)
  }
}

export type ShellKind = 'ps1' | 'bat' | 'sh' | 'command' | 'interactive' | 'script'

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
  /**
   * `ignoreKillError`：进程已确认结束（如强制更新 Server 结束的终端）时，结束进程失败也照常移除标签，
   * 不提示「关闭终端失败」。
   */
  closeTerminal: (id: string, options?: { ignoreKillError?: boolean }) => Promise<void>
  /** 进程已确认结束（如退出应用时选择结束远程终端）：只移除标签与输出缓存，不再结束进程。 */
  removeEndedTerminal: (id: string) => void
  closeOtherTerminals: (id: string) => Promise<void>
  closeAllProjectTerminals: (projectId: string) => Promise<void>
  closeProjectTerminals: (projectId: string) => Promise<void>
  restartTerminal: (id: string, options?: { preserveOutput?: boolean }) => Promise<void>
  reopenTerminalShell: (id: string) => Promise<void>
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
  /**
   * Spawn PTYs for tabs restored after restart (once).
   * `background`：启动后自动接回，只接回仍在运行的原进程，接不回时静默退回待恢复。
   */
  spawnRestoredTerminals: (projectId: string, options?: { background?: boolean }) => Promise<void>
  /** After the SSH workspace is ready, surface detached daemon terminals once. */
  syncDetachedTerminals: (projectId: string) => Promise<void>
  /** 列出 SSH 项目内没有本地标签的远端终端（不弹窗）；非 SSH 项目返回 null。 */
  findDetachedTerminals: (
    projectId: string,
  ) => Promise<{ connectionId: string; terminals: SshDetachedTerminal[] } | null>
  /** 把指定远端终端接回为本项目标签，返回成功数量。 */
  attachDetachedTerminals: (
    projectId: string,
    connectionId: string,
    terminals: SshDetachedTerminal[],
    options?: { background?: boolean },
  ) => Promise<number>
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
   * 让全屏 TUI 按当前行列整屏重绘：先缩一行再恢复，强制产生两次 SIGWINCH。
   * 用于视图重挂后回放的旧字节与当前网格不一致（尺寸未变时 resize 会被去重）。
   */
  /** 返回是否真的发出了重绘 SIGWINCH；未发出时调用方不必等待回包。 */
  redrawTerminal: (id: string, cols: number, rows: number) => Promise<boolean>
  /**
   * Create the PTY after xterm has fitted. Idempotent while `ptySpawnPending`.
   * Pass measured cols/rows so TUIs (e.g. OpenCode) start on the real grid.
   */
  spawnPendingTerminal: (
    id: string,
    cols: number,
    rows: number,
    options?: { background?: boolean },
  ) => Promise<void>
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
    if (terminalExitInProgress) return null
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
    const connection = sshConnectionIdFromUri(projectPath)
    // 未指定配置时（点「+」），远程连接自己的默认配置优先于全局默认。
    // 归属其他分类的全局默认回落到普通终端。
    const profile = getTerminalProfile(profileId ?? effectiveDefaultProfileIdFor(connection))
    if (!(await ensureTerminalProfileTrust(profile)) || terminalExitInProgress) return null
    const openRequestedAt = performance.now()
    const shell = normalizeTerminalShell(profile.shell)
    const startup = profile.command.trim().replace(/\s*\n+\s*/g, '; ')
    const remote = projectPath.startsWith('ssh://')
    // 远端 PowerShell 和 POSIX Shell 可领取普通预热项或对应的 CLI 会话。
    const canReserve = remote || getTerminalPersistLocalSessions()
    const selected = connection ? connectionPrewarmProfile(connection) : localCodexPrewarm()
    const requestedProfile = selected && selected.id === profile.id ? { profileId: profile.id, command: startup } : undefined
    const reservation = !canReserve ? { reason: 'persistence_disabled' }
      : requestedProfile ? await reservePrewarmedShell(projectPath, shell, !!startup, undefined, requestedProfile)
      : await reservePrewarmedShell(projectPath, shell, !!startup)
    if (terminalExitInProgress) return null
    const id = 'id' in reservation ? reservation.id : crypto.randomUUID()
    const profileSettings = loadTerminalProfileSettings()
    const nameShell = effectiveShellForTerminalName(shell, profileSettings.defaultShell)
    // 远端只收到配置自身的 shell（见 spawn），POSIX 远程不能按本机默认 Shell 命名。
    const posixSshLabel = posixSshShellLabelKey(projectPath, shell)
    const shellLabel =
      (posixSshLabel && translate(posixSshLabel)) ??
      windowsSshShellLabel(projectPath, nameShell) ??
      translate(terminalShellLabelKey(nameShell))
    const baseName = resolveNewTerminalName(
      profile.name,
      profile.command,
      DEFAULT_TERMINAL_PROFILE.name,
      shellLabel
    )
    const focusPane = get().terminalFocusPane
    // 新标签将替换的同窗格终端：兜底启动时按其网格估计尺寸。
    const paneSibling = readPaneTerminalId(get(), focusPane)
    // 配置命令可与新视图挂载并行。先保存同窗格的实测尺寸，切换标签时旧视图可能卸载。
    const startupGrid = startup && paneSibling ? terminalViewGrids.get(paneSibling) : undefined
    const tab: TerminalTab = {
      id,
      name: disambiguateTerminalName(
        baseName,
        sameProject.map(terminal => terminal.name)
      ),
      projectId,
      cwd: projectPath,
      openRequestedAt,
      prewarm: 'id' in reservation
        ? { outcome: 'reserved', ...(reservation.profileHit && { kind: 'profile' as const }) }
        : { outcome: 'miss', reason: reservation.reason },
      profileId: profile.id,
      shell,
      connectionId:
        project?.connection_id ?? sshConnectionIdFromUri(projectPath),
      // `;` joins multi-line profile commands for PowerShell-family shells.
      launchCommand: startup,
      pane: focusPane,
      // OSC titles rename the tab (cwd / apps); generic shell noise is filtered in UI.
      allowTitleRename: true,
      status: 'starting',
      exitCode: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      ptySpawnPending: true,
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      ...bindTerminalToPane(s, projectId, focusPane, id),
    }))
    // Ensure the panel has a non-zero height before xterm fit → PTY spawn.
    useUIStore.getState().openTerminalPanel()
    // 新视图先 fit 时会取消兜底。无可借用网格时给 fit 一小段时间，再启动配置命令。
    const fastSpawnDelay = startupGrid ? 0 : FAST_PTY_SPAWN_FALLBACK_MS
    schedulePtySpawnFallback(
      id,
      () => {
        const size = terminalViewGrids.get(id) ?? startupGrid ?? preferredSpawnSize(id, paneSibling)
        void get().spawnPendingTerminal(id, size.cols, size.rows)
      },
      startup || 'id' in reservation ? fastSpawnDelay : undefined
    )
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
    if (terminalExitInProgress) return null
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
      connectionId:
        project?.connection_id ?? sshConnectionIdFromUri(cwd),
      pane: focusPane,
      allowTitleRename: false,
      status: 'starting',
      exitCode: null,
      createdAt: Date.now(),
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
      const size = preferredSpawnSize(id)
      void get().spawnPendingTerminal(id, size.cols, size.rows)
    })
    return id
  },

  closeTerminal: async (id: string, options) => {
    const spawnInFlight = ptySpawnInFlight.has(id)
    clearPtySpawnFallback(id)
    ptySpawnInFlight.delete(id)
    lastPtySize.delete(id)
    deferredPtySync.delete(id)
    discardSpawnInput(id)
    markIntentionalPtyKill(id)
    const terminal = get().terminals.find(candidate => candidate.id === id)
    // Restored metadata has no PTY until its first spawn. Removing an opted-out
    // run-config tab must not call kill_terminal or show a false close error.
    if (terminal) {
      try {
        await killTerminalForClose(terminal, spawnInFlight)
      } catch (error) {
        if (options?.ignoreKillError) {
          console.warn(`close ended terminal ${id}: kill failed`, error)
        } else {
          useProjectStore
            .getState()
            .pushToast('error', translate('关闭终端失败: {error}', { error: String(error) }))
          releaseIntentionalPtyKill(id)
          return
        }
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

  removeEndedTerminal: (id: string) => {
    clearPtySpawnFallback(id)
    ptySpawnInFlight.delete(id)
    lastPtySize.delete(id)
    deferredPtySync.delete(id)
    discardSpawnInput(id)
    set(s => {
      const closed = s.terminals.find(t => t.id === id)
      if (!closed) return {}
      const terminals = s.terminals.filter(t => t.id !== id)
      return { terminals, ...clearClosedFromPanes(s, closed.projectId, id, terminals) }
    })
    clearTerminalOutput(id)
  },

  closeOtherTerminals: async (id: string) => {
    const keep = get().terminals.find(t => t.id === id)
    if (!keep) return
    const keepPane = terminalPaneOf(keep)
    const otherTabs = get()
      .terminals.filter(
        t =>
          t.projectId === keep.projectId &&
          t.id !== id &&
          terminalPaneOf(t) === keepPane,
      )
    const others = otherTabs.map(t => t.id)
    const spawnInFlight = new Map(otherTabs.map(tab => [tab.id, ptySpawnInFlight.has(tab.id)]))
    for (const tid of others) {
      clearPtySpawnFallback(tid)
      ptySpawnInFlight.delete(tid)
      lastPtySize.delete(tid)
      markIntentionalPtyKill(tid)
    }
    await Promise.all(
      otherTabs.map(tab =>
        killTerminalForClose(tab, spawnInFlight.get(tab.id) === true, 'user_close_others').catch(() => undefined),
      ),
    )
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
    const tabs = get().terminals.filter(t => t.projectId === projectId)
    const ids = tabs.map(t => t.id)
    const spawnInFlight = new Map(tabs.map(tab => [tab.id, ptySpawnInFlight.has(tab.id)]))
    for (const id of ids) {
      clearPtySpawnFallback(id)
      ptySpawnInFlight.delete(id)
      lastPtySize.delete(id)
      markIntentionalPtyKill(id)
    }
    await Promise.all(
      tabs.map(tab =>
        killTerminalForClose(tab, spawnInFlight.get(tab.id) === true, 'user_close_all').catch(() => undefined),
      ),
    )
    set(s => ({
      terminals: s.terminals.filter(t => t.projectId !== projectId),
      ...clearProjectPaneMaps(s, projectId, ids),
    }))
    ids.forEach(id => clearTerminalOutput(id))
  },

  closeProjectTerminals: async (projectId: string) => {
    const tabs = get().terminals.filter(terminal => terminal.projectId === projectId)
    const ids = tabs.map(terminal => terminal.id)
    const spawnInFlight = new Map(tabs.map(tab => [tab.id, ptySpawnInFlight.has(tab.id)]))
    for (const id of ids) {
      clearPtySpawnFallback(id)
      ptySpawnInFlight.delete(id)
      lastPtySize.delete(id)
      markIntentionalPtyKill(id)
    }
    await Promise.all(
      tabs.map(tab =>
        killTerminalForClose(tab, spawnInFlight.get(tab.id) === true).catch(() => undefined),
      ),
    )
    set(s => ({
      terminals: s.terminals.filter(terminal => terminal.projectId !== projectId),
      ...clearProjectPaneMaps(s, projectId, ids),
    }))
    ids.forEach(id => clearTerminalOutput(id))
  },

  reopenTerminalShell: async (id: string) => {
    const tab = get().terminals.find(terminal => terminal.id === id)
    if (!tab || tab.status !== 'exited' || tab.awaitingRestoreSpawn || tab.ptySpawnPending) return
    if (tab.restoreUnavailable) {
      set(state => ({ terminals: state.terminals.map(terminal => terminal.id === id ? {
        ...terminal, status: 'starting', restoreUnavailable: false, endedAt: undefined,
        awaitingRestoreSpawn: true, ptySpawnPending: true,
      } : terminal) }))
      return
    }
    set(state => ({ terminals: state.terminals.map(terminal => terminal.id === id ? {
      ...terminal, launchCommand: '', shellKind: undefined, profileId: 'default', env: {},
      runConfigId: undefined, runTaskId: undefined, allowTitleRename: true,
    } : terminal) }))
    await get().restartTerminal(id, { preserveOutput: true })
  },

  restartTerminal: async (id: string, options) => {
    if (terminalExitInProgress) return
    terminalRestartsInFlight.add(id)
    try {
      const tab = get().terminals.find(terminal => terminal.id === id)
      if (!tab) return
      if (tab.restoreUnavailable) { await get().reopenTerminalShell(id); return }
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
      const operationId = crypto.randomUUID()
      recordTerminalDiagnostic('terminal.restart_requested', tab, 'user_restart', operationId)
      try {
        await killTerminal(id, 'user_restart', operationId)
      } catch (error) {
        useProjectStore
          .getState()
          .pushToast('error', translate('结束终端进程失败: {error}', { error: String(error) }))
      }
      // Local kill removes the session before wait, so no terminal-exit follows.
      // Leaving the mark set would treat the replacement shell's later exit as
      // intentional and block input.
      releaseIntentionalPtyKill(id)
      // 旧进程结束后再领取，领取到的 Shell 由下面的新建链路按本标签 id 接回。
      const prewarm = await reserveShellForRestart(tab)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id
            ? {
                ...terminal,
                status: 'starting',
                prewarm,
                openRequestedAt: undefined,
                endedAt: undefined,
                restoreUnavailable: false,
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
    } finally {
      terminalRestartsInFlight.delete(id)
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
    // 启动恢复的会话里仍可能在运行的原进程：接回后汇总提示一次。
    trackStartupReattach(owned.filter(t => planTerminalRestore(t).mode === 'attach').map(t => t.id))
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

  spawnRestoredTerminals: async (projectId: string, options?: { background?: boolean }) => {
    const background = options?.background === true
    const pending = get().terminals.filter(
      t => t.projectId === projectId && t.awaitingRestoreSpawn && !restoreSpawnInFlight.has(t.id) &&
        // 后台只接回仍在运行的原进程；需要按原配置新建的（会重跑启动命令）留到切到项目时。
        (!background || planTerminalRestore(t).mode === 'attach')
    )
    if (pending.length === 0) return
    for (const t of pending) restoreSpawnInFlight.add(t.id)
    try {
      // Hydrated tabs have no live local PTY, so do not route through
      // restartTerminal: that would kill the daemon PTY we are trying to attach.
      set(s => ({
        terminals: s.terminals.map(terminal =>
          pending.some(t => t.id === terminal.id)
            ? {
                ...terminal,
                status: 'starting',
                exitCode: null,
                startedAt: Date.now(),
                restorePreservedOutput: true,
                ptySpawnPending: true,
              }
            : terminal
        ),
      }))
      await Promise.all(
        pending.map(t => {
          // 重启后 lastPtySize 为空：优先用已挂载视图的真实网格接回，快照与 TUI 重绘
          // 才会与视图同一网格，视图不必先缩到默认尺寸写快照。
          const size = preferredSpawnSize(t.id)
          return get().spawnPendingTerminal(t.id, size.cols, size.rows, { background })
        }),
      )
    } finally {
      for (const t of pending) restoreSpawnInFlight.delete(t.id)
    }
  },

  findDetachedTerminals: async (projectId: string) => {
    const projectState = useProjectStore.getState()
    const project =
      projectState.projects.find(candidate => candidate.id === projectId) ??
      (projectState.currentProject?.id === projectId ? projectState.currentProject : null)
    if (!project || !isSshProject(project)) return null
    const connectionId =
      project.connection_id ?? sshConnectionIdFromUri(project.path)
    if (!connectionId) return null
    const detached = await listDetachedTerminals(connectionId)
    // 同一连接下其他 SSH 项目的根：终端归给最深的包含根，不跨项目接回或结束。
    const connectionRoots = useProjectStore
      .getState()
      .projects.filter(
        candidate =>
          candidate.id !== project.id &&
          isSshProject(candidate) &&
          (candidate.connection_id ?? sshConnectionIdFromUri(candidate.path)) === connectionId
      )
      .map(candidate => candidate.path)
    const terminals = filterUnownedDetachedTerminals(
      detached,
      get().terminals,
      connectionId,
      project.path,
      connectionRoots,
    )
    const resolveName = terminalNameForReattach(projectId, get().terminals)
    return { connectionId, terminals: terminals.map(terminal => ({ ...terminal, name: resolveName(terminal) })) }
  },

  attachDetachedTerminals: async (
    projectId: string,
    connectionId: string,
    terminals: SshDetachedTerminal[],
    { background = false } = {},
  ) => {
    if (terminalExitInProgress || terminals.length === 0) return 0
    const currentTabs = get().terminals
    const available = terminals.filter(terminal => !currentTabs.some(tab =>
      tab.ptyId === terminal.ptyId && (!tab.connectionId || tab.connectionId === connectionId),
    ))
    if (available.length === 0) return 0
    const capacity = Math.max(
      0,
      MAX_TERMINALS_PER_PROJECT - currentTabs.filter(t => t.projectId === projectId).length,
    )
    const accepted = available.slice(0, capacity)
    if (accepted.length === 0) {
      if (!background) {
        useProjectStore.getState().pushToast('info', translate('每个项目最多可创建 {count} 个终端', {
          count: MAX_TERMINALS_PER_PROJECT,
        }))
      }
      return 0
    }

    const pane = get().terminalFocusPane
    const isCurrentProject = useProjectStore.getState().currentProject?.id === projectId
    const added: TerminalTab[] = []
    const names = [
      ...get().terminals.filter(tab => tab.projectId === projectId).map(tab => tab.name),
      ...accepted.flatMap(terminal => terminal.name ? [terminal.name] : []),
    ]
    for (const terminal of accepted) {
      const id = crypto.randomUUID()
      const name = terminal.name || disambiguateTerminalName(translate('远端终端'), names)
      if (!terminal.name) names.push(name)
      const tab: TerminalTab = {
        id,
        name,
        projectId,
        cwd: terminal.cwd,
        launchCommand: '',
        pane,
        status: 'starting',
        exitCode: null,
        createdAt: Date.now(),
        startedAt: Date.now(),
        persistent: true,
        ptyId: terminal.ptyId,
        connectionId,
        awaitingRestoreSpawn: true,
        ptySpawnPending: true,
      }
      set(state => ({
        terminals: [...state.terminals, tab],
        ...(background
          ? bindTerminalInBackground(state, projectId, pane, id, isCurrentProject)
          : bindTerminalToPane(state, projectId, pane, id)),
      }))
      added.push(tab)
    }
    if (!background) useUIStore.getState().openTerminalPanel()
    // 后台接回远端遗留终端（自动接回）也计入启动汇总提示；手动接回有自己的提示。
    else trackStartupReattach(added.map(tab => tab.id))
    await Promise.all(
      added.map(tab => {
        const terminal = accepted.find(candidate => candidate.ptyId === tab.ptyId)
        return get().spawnPendingTerminal(
          tab.id,
          terminal?.cols ?? DEFAULT_PTY_COLS,
          terminal?.rows ?? DEFAULT_PTY_ROWS,
        )
      }),
    )
    if (background) {
      // 批量接回失败的临时标签不占住 PTY 身份，让远端列表刷新后仍能重试。
      for (const tab of added) {
        const failed = get().terminals.find(terminal => terminal.id === tab.id)
        if (failed?.status !== 'exited' || !failed.restoreUnavailable) continue
        set(state => {
          const terminals = state.terminals.filter(terminal => terminal.id !== failed.id)
          return { terminals, ...clearClosedFromPanes(state, projectId, failed.id, terminals) }
        })
        disconnectNoticeShown.delete(failed.id)
        lastPtySize.delete(failed.id)
        clearTerminalOutput(failed.id)
      }
    }
    const recovered = added.filter(tab =>
      get().terminals.some(
        terminal => terminal.id === tab.id && terminal.status === 'running',
      ),
    ).length
    if (!background && recovered > 0) {
      useProjectStore
        .getState()
        .pushToast(
          'success',
          translate('已接回 {count} 个远端终端', { count: recovered }),
        )
    }
    if (!background && accepted.length < available.length) {
      useProjectStore
        .getState()
        .pushToast(
          'info',
          translate('受终端数量上限限制，还有 {count} 个远端终端未接回', {
            count: available.length - accepted.length,
          }),
        )
    }
    return recovered
  },

  syncDetachedTerminals: async (projectId: string) => {
    if (terminalExitInProgress) return
    const projectState = useProjectStore.getState()
    const project =
      projectState.projects.find(candidate => candidate.id === projectId) ??
      (projectState.currentProject?.id === projectId ? projectState.currentProject : null)
    if (!project || !isSshProject(project)) return
    const connectionId =
      project.connection_id ?? sshConnectionIdFromUri(project.path)
    if (!connectionId) return

    const syncKey = `${projectId}:${connectionId}`
    if (detachedTerminalSyncs.has(syncKey)) return
    detachedTerminalSyncs.add(syncKey)

    let found: Awaited<ReturnType<TerminalState['findDetachedTerminals']>>
    try {
      found = await get().findDetachedTerminals(projectId)
    } catch (error) {
      detachedTerminalSyncs.delete(syncKey)
      console.warn('ssh_list_detached_terminals failed:', error)
      return
    }
    const orphans = found?.terminals ?? []
    if (orphans.length === 0) return

    if (isTerminalAutoReattachEnabled()) {
      // 自动接回开启：直接在后台接回，不弹提示。没接回的（失败或超出数量上限）允许下次同步重试。
      const recovered = await get().attachDetachedTerminals(projectId, connectionId, orphans, { background: true })
      if (recovered < orphans.length) detachedTerminalSyncs.delete(syncKey)
      return
    }

    const openOrphanActions = async () => {
      if (terminalExitInProgress) return
      const action = await choiceDialog({
        title: translate('发现远端终端'),
        message: translate('远端还有 {count} 个终端在运行', {
          count: orphans.length,
        }),
        detail: translate('这些终端没有对应的本地标签，仍在该 SSH 连接上运行。'),
        options: [
          { id: 'attach', label: translate('接回'), primary: true },
          { id: 'kill', label: translate('全部结束'), danger: true },
          { id: 'later', label: translate('稍后处理') },
        ],
      })
      if (action !== 'attach' && action !== 'kill') return

      if (action === 'kill') {
        const failures: string[] = []
        for (const terminal of orphans) {
          try {
            await killDetachedTerminal({
              ptyId: terminal.ptyId,
              cwd: terminal.cwd,
            })
          } catch (error) {
            failures.push(
              `${terminal.name || terminal.ptyId}: ${String(error)}`,
            )
          }
        }
        if (failures.length > 0) {
          useProjectStore.getState().pushToast(
            'error',
            translate('结束远端终端失败: {error}', {
              error: failures[0],
            }),
            failures.length > 1
              ? translate('另有 {count} 个终端未能结束', {
                  count: failures.length - 1,
                })
              : undefined,
          )
        } else {
          useProjectStore
            .getState()
            .pushToast(
              'success',
              translate('已结束 {count} 个远端终端', { count: orphans.length }),
            )
        }
        return
      }

      await get().attachDetachedTerminals(projectId, connectionId, orphans)
    }

    useProjectStore.getState().pushToast(
      'info',
      translate('远端还有 {count} 个终端在运行', { count: orphans.length }),
      undefined,
      {
        label: translate('查看'),
        onAction: openOrphanActions,
      },
    )
  },

  activateProject: (projectId: string) =>
    set(s => {
      const projectTerminals = s.terminals.filter(terminal => terminal.projectId === projectId)
      // 副窗格按真实归属选择：单窗格布局下也保留它们的绑定，切回分屏时右侧仍是原来的终端。
      const owned = (pane: TerminalFocusPane) =>
        projectTerminals.filter(t =>
          pane === 'primary' ? terminalPaneOf(t) === 'primary' : t.pane === pane,
        )

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
    if (reconnectCancelInFlight.has(id)) return
    const tab = get().terminals.find(terminal => terminal.id === id)
    if (!tab) return
    if (tab.status === 'exited') {
      if (data === '\x03') await enterShellAfterTask(id)
      return
    }
    // 新建/接回在途（如远端服务更新中）后端还没有该终端：先暂存，就绪后补发。
    if (ptySpawnInFlight.has(id) || tab.ptySpawnPending || tab.awaitingRestoreSpawn) {
      if (!queueSpawnInput(id, data)) {
        useProjectStore.getState().pushToast('error', translate('终端尚未就绪，超出暂存上限的输入已丢弃'))
      }
      return
    }
    if (shouldCancelReconnectOnInput(tab, false, data)) {
      await cancelTerminalReconnect(id)
      return
    }
    recordTypedInput(id, data)
    noteHumanTerminalInput(id, data)
    if (data.includes('\r')) {
      noteTerminalSubmit(id)
      noteTerminalLastActive(id)
    }
    noteTerminalInput(id)
    try {
      await writeTerminal(id, data)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', translate('终端输入失败: {error}', { error: String(error) }))
    }
  },

  resizeTerminal: async (id: string, cols: number, rows: number) => {
    const mobile = isMobileTerminalId(id)
    if (mobile && (mobileViewsOpening.has(id)
      || !get().terminals.some(tab => tab.id === id && tab.status !== 'exited'))) return
    const size = normalizePtySize(cols, rows)
    if (ptySpawnInFlight.has(id)) {
      deferPtySync(id, { size })
      return
    }
    const previous = lastPtySize.get(id)
    // 行列没变就不要碰 PTY：ConPTY 每次 resize 都会整屏重绘，TUI 会跟着重排，
    // 而 Claude Code 会把每次重排追加进 scrollback（上游 #46834）。
    if (previous && previous.cols === size.cols && previous.rows === size.rows) return
    rememberPtySize(id, size.cols, size.rows)
    try {
      await sendPtySizePaced(id, size)
    } catch (error) {
      // 没下发成功就退回上一次的尺寸，否则同尺寸的重试会被上面的去重吞掉。
      // 普通 PTY 还没启动时保留首个尺寸给 spawn；手机 PTY 已存在，允许重试首个尺寸。
      // 期间若有更新的尺寸写进来，以新的为准。
      const remembered = lastPtySize.get(id)
      if (remembered?.cols === size.cols && remembered.rows === size.rows) {
        if (previous) lastPtySize.set(id, previous)
        else if (mobile) lastPtySize.delete(id)
      }
      console.warn('resize_terminal failed:', error)
    }
  },

  redrawTerminal: async (id: string, cols: number, rows: number) => {
    // 手机终端的首条尺寸请求用来适应电脑，不能用少一行的重绘尺寸。
    if (isMobileTerminalId(id)) return false
    const tab = get().terminals.find(terminal => terminal.id === id)
    const size = normalizePtySize(cols, rows)
    if (tab && ptySpawnInFlight.has(id)) {
      // 接回在途：快照可能先于登记到达，重绘留到接回完成后补发。
      deferPtySync(id, { size, redraw: true })
      return false
    }
    if (!tab || tab.status === 'exited' || tab.ptySpawnPending) return false
    if (size.rows < 2) return false
    try {
      // 两步之间按 PTY_RESIZE_MIN_GAP_MS 隔开：紧挨着发时 TUI 来不及响应中间尺寸，
      // 不但重绘不出来，conhost 还会裁掉最后一行，反而把画面弄坏。
      const before = lastPtySize.get(id)
      await sendPtySizePaced(id, { cols: size.cols, rows: size.rows - 1 })
      // 等待期间视图已下发了新尺寸（真实 resize 本身就会整屏重绘），不要再改回旧网格。
      if (lastPtySize.get(id) !== before) return true
      await sendPtySizePaced(id, size)
      rememberPtySize(id, size.cols, size.rows)
      return true
    } catch (error) {
      // 中途失败时 PTY 尺寸未知，清掉记录让下一次 resize 一定下发。
      lastPtySize.delete(id)
      console.warn('redraw_terminal failed:', error)
      return false
    }
  },

  spawnPendingTerminal: async (id: string, cols: number, rows: number, options?: { background?: boolean }) => {
    if (terminalExitInProgress) return
    const tab = get().terminals.find(terminal => terminal.id === id)
    if (!tab?.ptySpawnPending) return
    if (ptySpawnInFlight.has(id)) return
    // 请求失败时用户可能已经切换项目；恢复动作必须固定到该终端所属的原项目根。
    const projectState = useProjectStore.getState()
    const owner = projectState.projects.find(project => project.id === tab.projectId) ??
      (projectState.currentProject?.id === tab.projectId ? projectState.currentProject : null)
    const serverModeRootUri = owner?.path ?? ''
    ptySpawnInFlight.add(id)
    deferredPtySync.delete(id)
    clearPtySpawnFallback(id)
    const size = normalizePtySize(cols, rows)
    rememberPtySize(id, size.cols, size.rows)
    // Clear pending before await so concurrent fit callbacks do not double-spawn.
    set(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id ? { ...terminal, ptySpawnPending: false, openRequestedAt: undefined } : terminal
      ),
    }))
    try {
      let spawnResult: TerminalSpawnResult | undefined
      let attached = false
      let attachSize: { cols: number; rows: number } | null = null
      const restorePlan = planTerminalRestore(tab)
      if (restorePlan.mode === 'attach') {
        // 接回的是正在运行的进程：只按视图实测网格对齐，拿不到就沿用 PTY 现有尺寸，
        // 等视图 fit 后再下发一次真实尺寸（同 VS Code）。用猜的尺寸（默认 80x24）接回
        // 会把 PTY 先缩小再撑回：ConPTY 缩小时截掉的内容，TUI 因尺寸复原不会重画。
        attachSize = terminalViewGrids.get(id) ?? null
        if (attachSize) rememberPtySize(id, attachSize.cols, attachSize.rows)
        else lastPtySize.delete(id)
        try {
          spawnResult = await attachTerminal({
            id,
            ptyId: restorePlan.ptyId,
            cwd: restorePlan.cwd,
            cols: attachSize?.cols ?? null,
            rows: attachSize?.rows ?? null,
            fromSeq: terminalResumeSeqs.get(id) ?? null,
          })
          if (tab.cwd.startsWith('ssh://')) {
            forgetPreservedTerminalName(restorePlan.connectionId, restorePlan.ptyId)
          }
          attached = true
        } catch (error) {
          // Preserve the failed restore; never rerun the saved profile or task command.
          console.warn(`ssh_attach_terminal ${restorePlan.ptyId} failed:`, error)
          recordTerminalDiagnostic('terminal.restore_failed', tab)
          const gone = String(error).includes('QC_PTY_GONE:')
          const localGone = gone && restorePlan.fallback === 'create'
          // 后台自动接回不打扰：用户正看着的项目照常提示；其余项目接不回就静默退回待恢复，
          // 切到项目时再按原流程接回。本地托管宿主已不在时改为按原配置新建，同样留到切到项目时，
          // 不在后台重跑启动命令。远端进程确已结束时照常标记结束。
          const quiet = options?.background === true &&
            useProjectStore.getState().currentProject?.id !== tab.projectId
          if (quiet && (!gone || localGone)) {
            if (localGone) terminalResumeSeqs.delete(id)
            set(state => ({ terminals: state.terminals.map(terminal => terminal.id === id ? {
              ...terminal, status: 'exited', exitCode: null, awaitingRestoreSpawn: true, ptySpawnPending: true,
              ...(localGone ? { persistent: undefined, ptyId: undefined, connectionId: undefined } : {}),
            } : terminal) }))
            return
          }
          if (localGone) {
            // 本地托管终端的宿主随电脑重启消失：与普通本地终端一样按原配置新建，下面继续走创建流程。
            publishTerminalNotice(id, translate('原终端已结束，已按原配置重新启动。'))
          } else {
            set(state => ({ terminals: state.terminals.map(terminal => terminal.id === id ? {
              ...terminal, status: 'exited', exitCode: null, endedAt: gone ? Date.now() : undefined,
              restoreUnavailable: !gone, awaitingRestoreSpawn: false, ptySpawnPending: false,
            } : terminal) }))
            disconnectNoticeShown.add(id)
            publishTerminalNotice(id, translate(gone
              ? '终端会话已结束，输出已保留。'
              : '暂时无法接回终端，输出已保留。'))
            persistTerminalOutputNow()
            return
          }
        }
      }
      if (!get().terminals.some(terminal => terminal.id === id)) {
        if (spawnResult) await killTerminal(id, 'spawn_cancelled')
        return
      }
      if (!spawnResult) {
        // 新 PTY 的序号从头开始，旧续传序号作废。
        terminalResumeSeqs.delete(id)
        const plan = planTerminalSpawn(tab)
        if (plan.mode === 'script') {
          spawnResult = await spawnTerminalScript({
            id,
            cwd: tab.cwd,
            name: tab.name,
            shellKind: plan.shellKind,
            target: plan.target,
            env: plan.env,
            projectRoot: owner?.path,
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
            name: tab.name,
            persistLocal: getTerminalPersistLocalSessions(),
          })
        } else {
          spawnResult = await createTerminal({
            id,
            name: tab.name,
            cwd: tab.cwd,
            cols: size.cols,
            rows: size.rows,
            shell: tab.shell ?? null,
            persistLocal: getTerminalPersistLocalSessions(),
          })
        }
      }
      if (!get().terminals.some(terminal => terminal.id === id)) {
        await killTerminal(id, 'spawn_cancelled')
        return
      }
      // 以后端结果为准：接回失败回退新建时可能是直连终端（persistent=false），
      // 不能沿用旧 ptyId，否则断线提示消失、下次重启又去接回已失效的 PTY。
      applyTerminalSpawnResult(id, spawnResult)
      // 新建按请求尺寸起进程、接回前也按它对齐过网格：紧随其后的 resize 同样要隔开。
      markPtySizeChanged(id)
      const spawnedTab = get().terminals.find(terminal => terminal.id === id)
      if (spawnedTab) recordTerminalDiagnostic('terminal.spawned', spawnedTab)
      if (attached) noteTerminalReattached(id)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id
            ? {
                ...terminal,
                status: 'running',
                prewarm: spawnResult?.prewarmHit ? { outcome: 'hit', kind: terminal.prewarm?.kind }
                  : terminal.prewarm?.outcome === 'reserved' ? { outcome: 'miss', reason: 'claim_fallback' }
                  : terminal.prewarm,
                awaitingRestoreSpawn: false,
                restorePreservedOutput: undefined,
                ptySpawnPending: false,
              }
            : terminal
        ),
      }))
      if (tab.openRequestedAt !== undefined && !attached) {
        const result = get().terminals.find(terminal => terminal.id === id)?.prewarm
        if (result?.outcome === 'hit' || result?.outcome === 'miss') {
          recordShellOpen(tab.projectId, result.outcome, performance.now() - tab.openRequestedAt, result.reason)
        }
      }
      // 恢复时视图挂的常驻「正在接回」浮层：接回成功会被「已重新连接」替换，
      // 回退新建时没有连接事件，这里收起，免得它一直留着。
      if (activeTerminalOverlayNotice(id)?.sticky) clearTerminalOverlayNotice(id)
      // 先解除在途标记，补发的 resize/重绘才会真正下发。
      ptySpawnInFlight.delete(id)
      // 新建按 size 创建；接回按实测网格对齐，沿用 PTY 尺寸时本端不知道它的尺寸。
      const deferred = planDeferredPtySync(
        attached ? attachSize : size,
        deferredPtySync.get(id),
        attached
      )
      deferredPtySync.delete(id)
      if (deferred?.action === 'resize') {
        void get().resizeTerminal(id, deferred.cols, deferred.rows)
      } else if (deferred?.action === 'redraw') {
        void get().redrawTerminal(id, deferred.cols, deferred.rows)
      }
      const queuedInput = takeSpawnInput(id)
      if (queuedInput) void get().writeToTerminal(id, queuedInput)
    } catch (e) {
      console.error('spawnPendingTerminal failed:', e)
      clearTerminalOverlayNotice(id)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id
            ? {
                ...terminal,
                status: 'exited',
                prewarm: terminal.prewarm?.outcome === 'reserved' ? { outcome: 'unknown', reason: 'spawn_failed' } : terminal.prewarm,
                exitCode: null,
                awaitingRestoreSpawn: false,
                restorePreservedOutput: undefined,
                ptySpawnPending: false,
              }
            : terminal
        ),
      }))
      // 提示可能停留一段时间：用户若已手动重启，不能再结束正在运行的终端。
      const retry = () => {
        if (get().terminals.find(terminal => terminal.id === id)?.status !== 'exited') return
        return get().restartTerminal(id, { preserveOutput: true })
      }
      useProjectStore
        .getState()
        .pushToast('error', `新建终端失败: ${String(e)}`, undefined, serverModeErrorAction(e, serverModeRootUri, undefined, retry))
    } finally {
      ptySpawnInFlight.delete(id)
      deferredPtySync.delete(id)
      discardSpawnInput(id)
    }
  },

  renameTerminal: (id, name) =>
    set(s => {
      // 程序转圈时每帧都会以相同的清洗后标题调用这里：名字不变就保持原状态，
      // 避免每帧生成新数组导致所有订阅 terminals 的组件重渲染。
      const trimmed = name.trim()
      const target = s.terminals.find(t => t.id === id)
      if (!target || !trimmed || target.name === trimmed) return s
      return { terminals: s.terminals.map(t => (t === target ? { ...t, name: trimmed } : t)) }
    }),

  initializeTerminalEvents: async () => {
    const [
      unlistenData,
      unlistenInputError,
      unlistenExit,
      unlistenConnection,
      unlistenScreen,
      unlistenPoolNotice,
    ] = await Promise.all([
      listen<{ id: string; data: unknown; nextSeq?: unknown }>('terminal-data', event => {
        if (get().terminals.some(terminal => terminal.id === event.payload.id)) {
          // 在这里记录而不是在 xterm 订阅里：没挂载 xterm 的后台项目终端也要有运行状态。
          noteTerminalOutput(event.payload.id)
          publishTerminalOutput(event.payload.id, event.payload.data, event.payload.nextSeq)
        }
      }),
      listen<{ id: string; message: string }>('terminal-input-error', event => {
        const tab = get().terminals.find(terminal => terminal.id === event.payload.id)
        if (!tab || tab.status === 'exited') return
        useProjectStore.getState().pushToast('error', translate('终端输入失败: {error}', {
          error: `${terminalDisplayLabel(tab.name)}: ${event.payload.message}`,
        }))
      }),
      listen<unknown>('terminal-exit', event => {
        const parsed = parseTerminalExitEvent(event.payload)
        if (!parsed) return
        const { id, exitCode: exit_code, disconnected, reason } = parsed
        useTerminalControlStore.getState().clearControl(id)
        clearTerminalCommandActivity(id)
        clearTerminalProgramActivity(id)
        // 进程结束后屏幕可能被替换（重启/新 Shell），恢复时改用 ring 回放。
        const tab = get().terminals.find(t => t.id === id)
        if (!tab) {
          consumeIntentionalPtyKill(id)
          return
        }
        // close / restart / replace — do not treat as a soft shell death.
        if (consumeIntentionalPtyKill(id)) {
          // A replacement shell is already up or still starting. This exit
          // belongs to the process we killed, not a real disconnect.
          if (tab.ptySpawnPending || tab.status === 'starting' || tab.status === 'running') return
          set(s => ({
            terminals: s.terminals.map(terminal =>
              terminal.id === id ? { ...terminal, status: 'exited', exitCode: exit_code } : terminal
            ),
          }))
          return
        }
        recordTerminalDiagnostic('terminal.exit_received', { ...tab, exitCode: exit_code })
        if (disconnected) {
          publishTerminalNotice(id, translate('终端会话已结束，输出已保留。'))
          markDisconnectedExit(id)
          useTerminalStore.setState(state => ({ terminals: state.terminals.map(terminal =>
            terminal.id === id ? { ...terminal, disconnectReason: reason ?? terminal.disconnectReason,
              awaitingRestoreSpawn: false, ptySpawnPending: false } : terminal),
          }))
          persistTerminalOutputNow()
          return
        }
        persistTerminalOutputNow()
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
                  endedAt: Date.now(),
                  lastActiveAt: Date.now(),
                }
              : terminal
          ),
        }))
        if (!isTerminalInView(id)) markTerminalAttention(id)
        // 后台项目的终端不抢当前终端：activeTerminalId 只能指向当前项目，由列表上的标记提示。
        if (quickFail && tab.projectId === useProjectStore.getState().currentProject?.id) {
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
      listen<unknown>('terminal-connection', event => {
        if (!event.payload || typeof event.payload !== 'object') return
        const payload = event.payload as Record<string, unknown>
        const id = typeof payload.id === 'string' ? payload.id : null
        if (!id) return
        const tab = get().terminals.find(terminal => terminal.id === id)
        if (!tab || tab.persistent !== true) return
        const plan = planTerminalConnectionEvent(tab, payload)
        if (!plan) return
        set(s => ({
          terminals: s.terminals.map(terminal =>
            terminal.id === id
              ? {
                  ...terminal,
                  status: plan.status,
                  exitCode: null,
                  connectionAttempt: plan.attempt ?? terminal.connectionAttempt,
                  disconnectReason: plan.reason ?? terminal.disconnectReason,
                }
              : terminal
          ),
        }))
        if (plan.notice) {
          publishTerminalConnectionNotice(
            id,
            translate(plan.notice.key, plan.notice.values),
            plan.status === 'reconnecting',
          )
        } else if (plan.status === 'running' && activeTerminalOverlayNotice(id)?.sticky) {
          // 已在运行时再收到 attached（无提示）：收起可能残留的常驻重连浮层，
          // 不打断刚显示的「已重新连接」。
          clearTerminalOverlayNotice(id)
        }
      }),
      listen('terminal-screen', event => {
        const screen = parseTerminalScreenPayload(event.payload)
        if (!screen || !get().terminals.some(terminal => terminal.id === screen.id)) return
        applyTerminalScreen(
          screen.id,
          { data: screen.data, cols: screen.cols, rows: screen.rows },
          screen.nextSeq
        )
      }),
      // server 模式终端共用 SSH 连接；已有连接按 sshd MaxSessions 占满、新开连接时提示。
      listen<{ message?: unknown }>('ssh-terminal-pool-notice', event => {
        const message = event.payload?.message
        if (typeof message !== 'string' || !message.trim()) return
        useProjectStore.getState().pushToast('info', message)
      }),
    ])
    const unsubscribeView = subscribeTerminalViewSources()

    return () => {
      unsubscribeView()
      unlistenData()
      unlistenExit()
      unlistenInputError()
      unlistenConnection()
      unlistenScreen()
      unlistenPoolNotice()
    }
  },
}))

// 输出缓冲持久化时按当前标签顺序收集终端。
registerTerminalOutputPersistSource(() =>
  useTerminalStore.getState().terminals.map(terminal => terminal.id)
)

// Durable terminal metadata is persisted via workspaceSessionSync (localStorage).
// Scrollback / command history is persisted separately (terminalSessionPersist).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    persistTerminalOutputNow({ renderScreens: true })
  })
}

/**
 * 把手机终端打开为电脑标签。`background` 时只加入标签，不抢占正在显示的终端，
 * 便于在终端管理里连续打开多个。
 */
export async function openMobileSessionTab(session: {
  id: string
  name: string
  createdAt?: number | null
  project: { id: string; path: string }
}, options: { background?: boolean } = {}): Promise<TerminalTab> {
  const state = useTerminalStore.getState()
  const existing = state.terminals.find(tab => tab.id === session.id)
  if (existing) return existing
  const pane = state.terminalFocusPane
  const tab: TerminalTab = {
    id: session.id,
    name: session.name,
    projectId: session.project.id,
    cwd: session.project.path,
    launchCommand: '',
    pane,
    status: 'running',
    exitCode: null,
    createdAt: session.createdAt ?? Date.now(),
    startedAt: Date.now(),
  }
  // 先建标签再打开：首屏快照到达时要能找到它。
  const isCurrentProject = useProjectStore.getState().currentProject?.id === tab.projectId
  mobileViewsOpening.add(tab.id)
  useTerminalStore.setState(current => ({
    terminals: [...current.terminals, tab],
    ...(options.background
      ? bindTerminalInBackground(current, tab.projectId, pane, tab.id, isCurrentProject)
      : bindTerminalToPane(current, tab.projectId, pane, tab.id)),
  }))
  try {
    // 共享状态（在线设备、尺寸方、独占）由 Rust 随打开发出的 terminal-control 事件带来。
    await openMobileView(session.id)
  } catch (error) {
    await useTerminalStore.getState().closeTerminal(session.id)
    throw error
  } finally {
    mobileViewsOpening.delete(tab.id)
  }
  // 打开期间视图可能已 fit，后端登记完成后补发；无实测网格的后台标签等视图挂载。
  const grid = terminalViewGrids.get(tab.id)
  if (grid) void useTerminalStore.getState().resizeTerminal(tab.id, grid.cols, grid.rows)
  return tab
}

/** 此刻显示在界面上的终端：当前项目里各窗格绑定的终端。 */
function terminalIdsInView(): Set<string> {
  const state = useTerminalStore.getState()
  const projectId = useProjectStore.getState().currentProject?.id
  // 单窗格的工作台里，副窗格绑定只是保留给切回分屏用，并不显示。
  const panes =
    useUIStore.getState().panelLayout === 'terminalWorkbench' ? ['primary' as const] : TERMINAL_FOCUS_PANES
  const ids = new Set<string>()
  for (const pane of panes) {
    const id = readPaneTerminalId(state, pane)
    // 切项目后各窗格绑定要等项目激活才更新，期间仍指向上一个项目的终端，并不显示。
    if (id && state.terminals.some(tab => tab.id === id && tab.projectId === projectId)) ids.add(id)
  }
  return ids
}

/**
 * 当前项目与面板布局也决定哪些终端可见：切回项目时当前终端可能没变，同样算看过。
 * 在初始化终端事件时订阅，避免导入本模块时就依赖其他 store。
 */
function subscribeTerminalViewSources(): () => void {
  const unsubscribeProject = useProjectStore.subscribe((state, previous) => {
    if (state.currentProject?.id !== previous.currentProject?.id) syncTerminalsInView(terminalIdsInView())
  })
  const unsubscribeUI = useUIStore.subscribe((state, previous) => {
    if (state.panelLayout !== previous.panelLayout) syncTerminalsInView(terminalIdsInView())
  })
  syncTerminalsInView(terminalIdsInView())
  return () => {
    unsubscribeProject()
    unsubscribeUI()
  }
}

/** 终端此刻是否显示在界面上；已关闭的终端视为无需提示。 */
function isTerminalInView(id: string): boolean {
  if (!useTerminalStore.getState().terminals.some(tab => tab.id === id)) return true
  return terminalIdsInView().has(id)
}

/** 回车提交太密时不必每次写状态和快照：列表按分钟显示，30 秒误差看不出来。 */
const LAST_ACTIVE_SUBMIT_THROTTLE_MS = 30_000

/** 更新终端的最后活动时间；force 用于任务结束，此时必须记下准确时间。 */
export function noteTerminalLastActive(id: string, at = Date.now(), force = false) {
  const tab = useTerminalStore.getState().terminals.find(terminal => terminal.id === id)
  if (!tab) return
  const previous = tab.lastActiveAt ?? 0
  if (at <= previous) return
  if (!force && at - previous < LAST_ACTIVE_SUBMIT_THROTTLE_MS) return
  useTerminalStore.setState(state => ({
    terminals: state.terminals.map(terminal =>
      terminal.id === id ? { ...terminal, lastActiveAt: at } : terminal
    ),
  }))
}

/** 程序正在工作的终端；从工作转为空闲时记为一次活动（任务完成）。 */
const busyForLastActive = new Set<string>()

subscribeTerminalProgramActivity(id => {
  const busy = getTerminalProgramBusySnapshot(id)
  const lastWorkAt = getTerminalLastWorkAt(id)
  noteTerminalBusyChange(id, busy, isTerminalInView(id), lastWorkAt)
  if (busy) busyForLastActive.add(id)
  else if (busyForLastActive.delete(id)) noteTerminalLastActive(id, lastWorkAt || Date.now(), true)
})

useTerminalStore.subscribe((state, previous) => {
  if (state.terminals !== previous.terminals) {
    const existingIds = new Set(state.terminals.map(tab => tab.id))
    pruneTerminalAttention(existingIds)
    for (const id of busyForLastActive) if (!existingIds.has(id)) busyForLastActive.delete(id)
  }
  if (
    state.terminals !== previous.terminals ||
    TERMINAL_FOCUS_PANES.some(pane => readPaneTerminalId(state, pane) !== readPaneTerminalId(previous, pane))
  ) {
    syncTerminalsInView(terminalIdsInView())
  }
})
