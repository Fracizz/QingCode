import type { EditorTab } from '../types'
import { isPinnedSettingsTab } from '../utils/editorHelpers'

export type PendingReveal = {
  path: string
  line: number
  /** 1-based column; when set (and `from` is not), Editor places the caret on this column. */
  column?: number
  /** Optional document offset; when set, Editor scrolls/selects here instead of line/column. */
  from?: number
}

export interface ProjectEditorSession {
  tabs: EditorTab[]
  activeTabId: string | null
  pendingReveal: PendingReveal | null
}

export function fileNameFromPath(path: string) {
  return path.split('\\').pop() || path.split('/').pop() || path
}

export function pendingRevealAt(
  path: string,
  line?: number,
  column?: number,
): PendingReveal | null {
  if (!line || line < 1) return null
  const reveal: PendingReveal = { path, line }
  if (column !== undefined && column >= 1) reveal.column = column
  return reveal
}

export function buildTabMru(tabs: EditorTab[], activeTabId: string | null): string[] {
  const ids = tabs.map(tab => tab.id)
  if (!activeTabId) return ids
  return [activeTabId, ...ids.filter(id => id !== activeTabId)]
}

export function splitPinned(tabs: EditorTab[]) {
  const pinned: EditorTab[] = []
  const projectTabs: EditorTab[] = []
  for (const tab of tabs) {
    if (isPinnedSettingsTab(tab.path)) pinned.push(tab)
    else projectTabs.push(tab)
  }
  return { pinned, projectTabs }
}

type EditorTabsState = {
  tabs: EditorTab[]
  projectSessions: Record<string, ProjectEditorSession>
}

export function mapTabEverywhere(
  state: EditorTabsState,
  id: string,
  mapTab: (tab: EditorTab) => EditorTab,
): EditorTabsState | null {
  if (state.tabs.some(tab => tab.id === id)) {
    return {
      tabs: state.tabs.map(tab => (tab.id === id ? mapTab(tab) : tab)),
      projectSessions: state.projectSessions,
    }
  }
  for (const [projectId, session] of Object.entries(state.projectSessions)) {
    if (!session.tabs.some(tab => tab.id === id)) continue
    return {
      tabs: state.tabs,
      projectSessions: {
        ...state.projectSessions,
        [projectId]: {
          ...session,
          tabs: session.tabs.map(tab => (tab.id === id ? mapTab(tab) : tab)),
        },
      },
    }
  }
  return null
}
