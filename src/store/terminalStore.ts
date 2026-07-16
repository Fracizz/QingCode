import { create } from 'zustand'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { safeInvoke } from '../lib/tauri'
import { useProjectStore } from './projectStore'
import type { TerminalTab } from '../types'

export const MAX_TERMINALS_PER_PROJECT = 10
const STORAGE_KEY = 'qingcode:terminal-layout'

export type ShellKind = 'ps1' | 'bat' | 'sh' | 'command' | 'script'

interface PersistedTerminalState {
  terminals: TerminalTab[]
  activeTerminalByProject: Record<string, string>
}

function loadPersistedState(): PersistedTerminalState {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (!value) return { terminals: [], activeTerminalByProject: {} }
    const parsed = JSON.parse(value) as Partial<PersistedTerminalState>
    const terminals = Array.isArray(parsed.terminals)
      ? parsed.terminals
          .filter(tab => tab?.id && tab?.projectId && tab?.cwd)
          .map(tab => ({ ...tab, status: 'exited' as const, exitCode: null }))
      : []
    return {
      terminals,
      activeTerminalByProject: parsed.activeTerminalByProject ?? {},
    }
  } catch {
    return { terminals: [], activeTerminalByProject: {} }
  }
}

interface TerminalState {
  terminals: TerminalTab[]
  activeTerminalId: string | null
  activeTerminalByProject: Record<string, string>
  addTerminal: (projectPath: string, projectId: string) => Promise<string | null>
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
  activateProject: (projectId: string) => void
  updateProjectPath: (projectId: string, path: string) => void
  setActiveTerminal: (id: string) => void
  writeToTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
  renameTerminal: (id: string, name: string) => void
  initializeTerminalEvents: () => Promise<UnlistenFn>
}

const persisted = loadPersistedState()

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: persisted.terminals,
  activeTerminalId: null,
  activeTerminalByProject: persisted.activeTerminalByProject,

  addTerminal: async (projectPath: string, projectId: string) => {
    const sameProject = get().terminals.filter(t => t.projectId === projectId)
    if (sameProject.length >= MAX_TERMINALS_PER_PROJECT) {
      useProjectStore
        .getState()
        .pushToast('info', `每个项目最多可创建 ${MAX_TERMINALS_PER_PROJECT} 个终端`)
      return null
    }
    const id = crypto.randomUUID()
    const nextNumber =
      sameProject.reduce((max, terminal) => {
        const match = /^终端 (\d+)$/.exec(terminal.name) ?? /^Terminal (\d+)$/.exec(terminal.name)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0) + 1
    const tab: TerminalTab = {
      id,
      name: `终端 ${nextNumber}`,
      projectId,
      cwd: projectPath,
      status: 'starting',
      exitCode: null,
    }
    set(s => ({
      terminals: [...s.terminals, tab],
      activeTerminalId: id,
      activeTerminalByProject: { ...s.activeTerminalByProject, [projectId]: id },
    }))
    try {
      await safeInvoke('新建终端', 'create_terminal', { id, cwd: projectPath })
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
      status: 'starting',
      exitCode: null,
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
        shell_kind: shellKind,
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
  },

  restartTerminal: async (id: string) => {
    const tab = get().terminals.find(terminal => terminal.id === id)
    if (!tab) return
    set(s => ({
      terminals: s.terminals.map(terminal =>
        terminal.id === id ? { ...terminal, status: 'starting', exitCode: null } : terminal
      ),
    }))
    try {
      await safeInvoke('重启终端', 'create_terminal', { id, cwd: tab.cwd })
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

  initializeTerminalEvents: () =>
    listen<{ id: string; exit_code: number }>('terminal-exit', event => {
      set(s => ({
        terminals: s.terminals.map(terminal =>
          terminal.id === event.payload.id
            ? {
                ...terminal,
                status: 'exited',
                exitCode: event.payload.exit_code,
              }
            : terminal
        ),
      }))
    }),
}))

useTerminalStore.subscribe(state => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        terminals: state.terminals,
        activeTerminalByProject: state.activeTerminalByProject,
      } satisfies PersistedTerminalState)
    )
  } catch {}
})
