import { create } from 'zustand'
import { safeInvoke } from '../lib/tauri'
import { useProjectStore } from './projectStore'
import type { EditorTab } from '../types'

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string | null
  pendingReveal: { path: string; line: number } | null
  openFile: (path: string, line?: number) => Promise<void>
  clearPendingReveal: () => void
  closeTab: (id: string) => void
  closeOtherTabs: (id: string) => void
  closeTabsToRight: (id: string) => void
  setActiveTab: (id: string) => void
  setTabContent: (id: string, content: string) => void
  markDirty: (id: string) => void
  markClean: (id: string) => void
  saveFile: (id: string) => Promise<void>
  closeAllTabs: () => void
  renamePath: (oldPath: string, newPath: string) => void
  closeTabsForPath: (path: string) => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  pendingReveal: null,

  clearPendingReveal: () => set({ pendingReveal: null }),

  openFile: async (path: string, line?: number) => {
    const existing = get().tabs.find(t => t.path === path)
    if (existing) {
      set({
        activeTabId: existing.id,
        pendingReveal: line ? { path, line } : null,
      })
      return
    }
    try {
      const content = await safeInvoke<string>('读取文件', 'read_file', { path })
      const name = path.split('\\').pop() || path.split('/').pop() || path
      const id = crypto.randomUUID()
      const lang = guessLanguage(path)
      const tab: EditorTab = { id, path, name, dirty: false, content, language: lang }
      set(s => ({
        tabs: [...s.tabs, tab],
        activeTabId: id,
        pendingReveal: line ? { path, line } : null,
      }))
    } catch (e) {
      console.error('openFile failed:', e)
      useProjectStore.getState().pushToast('error', `打开文件失败: ${String(e)}`)
    }
  },

  closeTab: (id: string) => {
    set(s => {
      const tabs = s.tabs.filter(t => t.id !== id)
      const activeTabId = s.activeTabId === id
        ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
        : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  closeOtherTabs: (id: string) => {
    set(s => {
      const tabs = s.tabs.filter(t => t.id === id)
      return { tabs, activeTabId: tabs.length > 0 ? id : null }
    })
  },

  closeTabsToRight: (id: string) => {
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === id)
      if (idx === -1) return s
      const tabs = s.tabs.slice(0, idx + 1)
      const activeTabId = tabs.some(t => t.id === s.activeTabId) ? s.activeTabId : id
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (id: string) => set({ activeTabId: id }),

  setTabContent: (id: string, content: string) => {
    set(s => ({
      tabs: s.tabs.map(t => t.id === id ? { ...t, content } : t)
    }))
  },

  markDirty: (id: string) => {
    set(s => ({
      tabs: s.tabs.map(t => t.id === id ? { ...t, dirty: true } : t)
    }))
  },

  markClean: (id: string) => {
    set(s => ({
      tabs: s.tabs.map(t => t.id === id ? { ...t, dirty: false } : t)
    }))
  },

  saveFile: async (id: string) => {
    const tab = get().tabs.find(t => t.id === id)
    if (!tab || !tab.content) return
    try {
      await safeInvoke('保存文件', 'write_file', { path: tab.path, content: tab.content })
      get().markClean(id)
    } catch (e) {
      console.error('saveFile failed:', e)
      useProjectStore.getState().pushToast('error', `保存文件失败: ${String(e)}`)
    }
  },

  closeAllTabs: () => set({ tabs: [], activeTabId: null }),

  renamePath: (oldPath: string, newPath: string) =>
    set(s => ({
      tabs: s.tabs.map(tab => {
        if (tab.path !== oldPath && !isDescendantPath(tab.path, oldPath)) return tab
        const path = newPath + tab.path.slice(oldPath.length)
        const name = path.split('\\').pop() || path.split('/').pop() || path
        return { ...tab, path, name }
      }),
    })),

  closeTabsForPath: (path: string) =>
    set(s => {
      const closedIds = new Set(
        s.tabs
          .filter(tab => tab.path === path || isDescendantPath(tab.path, path))
          .map(tab => tab.id)
      )
      const tabs = s.tabs.filter(tab => !closedIds.has(tab.id))
      return {
        tabs,
        activeTabId: closedIds.has(s.activeTabId ?? '')
          ? tabs[tabs.length - 1]?.id ?? null
          : s.activeTabId,
      }
    }),
}))

function isDescendantPath(candidate: string, parent: string) {
  return candidate.startsWith(`${parent}\\`) || candidate.startsWith(`${parent}/`)
}

function guessLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    json: 'json', md: 'markdown', css: 'css', html: 'html',
    py: 'python', rs: 'rust', toml: 'toml', yml: 'yaml', yaml: 'yaml',
    xml: 'xml', sh: 'shell', bat: 'bat', ps1: 'powershell',
    go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  }
  return map[ext] || 'plain'
}
