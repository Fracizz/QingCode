import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { safeInvoke } from '../lib/tauri'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'
import type { TerminalTab } from '../types'
import { DEFAULT_TERMINAL_PROFILE, getTerminalProfile } from '../lib/terminalProfiles'
import { ensureTerminalProfileTrust } from '../lib/terminalProfileTrust'
import { isProjectTrusted } from '../lib/workspaceTrust'
import { disambiguateTerminalName, resolveNewTerminalName, terminalDisplayLabel } from '../utils/terminalName'
import { translate } from '../lib/i18n'

export const MAX_TERMINALS_PER_PROJECT = 10
/** @deprecated Cleared on boot; durable metadata lives in workspaceSessionPersist. */
const LEGACY_SESSION_STORAGE_KEY = 'qingcode:terminal-layout'
const MAX_BUFFERED_OUTPUT_LENGTH = 1024 * 1024

/** 够"快"才算启动失败：进程在此时长（毫秒）内非零退出，视为秒退并提示。 */
const QUICK_FAIL_THRESHOLD_MS = 2000

type TerminalOutputListener = (data: Uint8Array) => void

const terminalOutputBuffers = new Map<string, Uint8Array>()
const terminalOutputListeners = new Map<string, Set<TerminalOutputListener>>()

function publishTerminalOutput(id: string, data: number[]) {
  const bytes = new Uint8Array(data)
  const listeners = terminalOutputListeners.get(id)
  if (listeners?.size) {
    listeners.forEach(listener => listener(bytes))
    return
  }

  const previous = terminalOutputBuffers.get(id)
  const buffered = new Uint8Array((previous?.length ?? 0) + bytes.length)
  if (previous) buffered.set(previous)
  buffered.set(bytes, previous?.length ?? 0)
  terminalOutputBuffers.set(
    id,
    buffered.length > MAX_BUFFERED_OUTPUT_LENGTH
      ? buffered.slice(buffered.length - MAX_BUFFERED_OUTPUT_LENGTH)
      : buffered
  )
}

function clearTerminalOutput(id: string) {
  terminalOutputBuffers.delete(id)
}

export function subscribeTerminalOutput(id: string, listener: TerminalOutputListener) {
  const listeners = terminalOutputListeners.get(id) ?? new Set<TerminalOutputListener>()
  listeners.add(listener)
  terminalOutputListeners.set(id, listeners)

  const buffered = terminalOutputBuffers.get(id)
  if (buffered) {
    terminalOutputBuffers.delete(id)
    listener(buffered)
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) terminalOutputListeners.delete(id)
  }
}

export type ShellKind = 'ps1' | 'bat' | 'sh' | 'command' | 'script'

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
    name: string
  ) => Promise<string | null>
  closeTerminal: (id: string) => Promise<void>
  closeOtherTerminals: (id: string) => Promise<void>
  closeAllProjectTerminals: (projectId: string) => Promise<void>
  closeProjectTerminals: (projectId: string) => Promise<void>
  restartTerminal: (id: string) => Promise<void>
  /** Seed tabs from durable workspace session (no PTY yet). */
  hydrateTerminalSessions: (
    terminals: TerminalTab[],
    activeTerminalByProject: Record<string, string>,
  ) => void
  /** Spawn PTYs for tabs restored after restart (once). */
  spawnRestoredTerminals: (projectId: string) => Promise<void>
  activateProject: (projectId: string) => void
  updateProjectPath: (projectId: string, path: string) => void
  setActiveTerminal: (id: string) => void
  writeToTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
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
    const id = crypto.randomUUID()
    const nextNumber =
      sameProject.reduce((max, terminal) => {
        const match = /^终端 (\d+)$/.exec(terminal.name) ?? /^Terminal (\d+)$/.exec(terminal.name)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0) + 1
    const baseName = resolveNewTerminalName(
      profile.name,
      profile.command,
      nextNumber,
      DEFAULT_TERMINAL_PROFILE.name
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
      launchCommand: profile.command.trim().replace(/\s*\n+\s*/g, ' && '),
      allowTitleRename: true,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      activeTerminalId: id,
      activeTerminalByProject: { ...s.activeTerminalByProject, [projectId]: id },
    }))
    try {
      if (tab.launchCommand) {
        await safeInvoke('启动终端配置', 'spawn_script', {
          id,
          cwd: projectPath,
          shellKind: 'command',
          target: tab.launchCommand,
          env: {},
        })
      } else {
        await safeInvoke('新建终端', 'create_terminal', { id, cwd: projectPath })
      }
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id && terminal.status === 'starting'
            ? { ...terminal, status: 'running' }
            : terminal
        ),
      }))
    } catch (e) {
      console.error('create_terminal failed:', e)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id ? { ...terminal, status: 'exited', exitCode: null } : terminal
        ),
      }))
      useProjectStore.getState().pushToast('error', `新建终端失败: ${String(e)}`)
    }
    return id
  },

  addScriptTerminal: async (
    projectId: string,
    cwd: string,
    shellKind: ShellKind,
    target: string,
    env: Record<string, string>,
    name: string
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
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      activeTerminalId: id,
      activeTerminalByProject: { ...s.activeTerminalByProject, [projectId]: id },
    }))
    try {
      await safeInvoke('启动任务', 'spawn_script', {
        id,
        cwd,
        shellKind,
        target,
        env,
      })
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id && terminal.status === 'starting'
            ? { ...terminal, status: 'running' }
            : terminal
        ),
      }))
    } catch (e) {
      console.error('spawn_script failed:', e)
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id ? { ...terminal, status: 'exited', exitCode: null } : terminal
        ),
      }))
      useProjectStore.getState().pushToast('error', `启动任务失败: ${String(e)}`)
    }
    return id
  },

  closeTerminal: async (id: string) => {
    try {
      await safeInvoke('关闭终端', 'kill_terminal', { id })
    } catch {}
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
    await Promise.all(
      others.map(tid => safeInvoke('关闭终端', 'kill_terminal', { id: tid }).catch(() => undefined))
    )
    set(s => {
      const terminals = s.terminals.filter(t => !(t.projectId === keep.projectId && t.id !== id))
      const activeTerminalByProject = { ...s.activeTerminalByProject }
      activeTerminalByProject[keep.projectId] = id
      return { terminals, activeTerminalId: id, activeTerminalByProject }
    })
    others.forEach(clearTerminalOutput)
  },

  closeAllProjectTerminals: async (projectId: string) => {
    const ids = get()
      .terminals.filter(t => t.projectId === projectId)
      .map(t => t.id)
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
    ids.forEach(clearTerminalOutput)
  },

  closeProjectTerminals: async (projectId: string) => {
    const ids = get()
      .terminals.filter(terminal => terminal.projectId === projectId)
      .map(terminal => terminal.id)
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
    ids.forEach(clearTerminalOutput)
  },

  restartTerminal: async (id: string) => {
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
    clearTerminalOutput(id)
    set(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id
          ? {
              ...terminal,
              status: 'starting',
              exitCode: null,
              startedAt: Date.now(),
              awaitingRestoreSpawn: false,
            }
          : terminal
      ),
    }))
    try {
      if (tab.launchCommand) {
        // Banner is written by Terminal.tsx after reset; avoid double echo.
        await safeInvoke('重启终端配置', 'spawn_script', {
          id,
          cwd: tab.cwd,
          shellKind: tab.shellKind ?? 'command',
          target: tab.launchCommand,
          env: tab.env ?? {},
        })
      } else {
        await safeInvoke('重启终端', 'create_terminal', { id, cwd: tab.cwd })
      }
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id && terminal.status === 'starting'
            ? { ...terminal, status: 'running' }
            : terminal
        ),
      }))
    } catch (e) {
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === id ? { ...terminal, status: 'exited', exitCode: null } : terminal
        ),
      }))
      useProjectStore.getState().pushToast('error', `重启终端失败: ${String(e)}`)
    }
  },

  hydrateTerminalSessions: (terminals, activeTerminalByProject) => {
    set({
      terminals,
      activeTerminalId: null,
      activeTerminalByProject: { ...activeTerminalByProject },
    })
  },

  spawnRestoredTerminals: async (projectId: string) => {
    const pending = get().terminals.filter(
      t => t.projectId === projectId && t.awaitingRestoreSpawn,
    )
    if (pending.length === 0) return
    // Clear flags first so concurrent effect runs do not double-spawn.
    set(s => ({
      terminals: s.terminals.map(t =>
        t.projectId === projectId && t.awaitingRestoreSpawn
          ? { ...t, awaitingRestoreSpawn: false }
          : t,
      ),
    }))
    await Promise.all(pending.map(t => get().restartTerminal(t.id)))
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
    try {
      await safeInvoke('终端输入', 'write_terminal', { id, data })
    } catch {}
  },

  resizeTerminal: async (id: string, cols: number, rows: number) => {
    try {
      await safeInvoke('终端尺寸', 'resize_terminal', { id, cols, rows })
    } catch {}
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
        const tab = get().terminals.find(t => t.id === id)
        const startedAt = tab?.startedAt
        const quickFail =
          !!tab &&
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
        if (quickFail && tab) {
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
