import { clearDraft, getDraft } from './draftRecovery'
import type {
  PersistedEditorTab,
  PersistedProjectSession,
} from './workspaceSessionPersist'
import { isTerminalShellId, normalizeTerminalShell } from './terminalShell'
import type { ProjectEditorSession } from '../store/editorStore'
import type { EditorTab, TerminalTab } from '../types'
import { guessLanguage, isPinnedSettingsTab, tabNameFromPath } from '../utils/editorHelpers'

export function tabFromPersisted(tab: PersistedEditorTab): EditorTab {
  const draft = tab.dirty ? getDraft(tab.path) : null
  if (tab.dirty && draft) clearDraft(tab.path)

  const dirty = tab.dirty && !!draft
  const editorTab: EditorTab = {
    id: tab.id,
    path: tab.path,
    name: tab.name || tabNameFromPath(tab.path),
    dirty: tab.viewMode === 'view' ? false : dirty,
    language: tab.language || guessLanguage(tab.path),
    viewMode: tab.viewMode === 'view' ? 'view' : 'edit',
  }
  if (draft && tab.viewMode !== 'view') editorTab.content = draft.content
  return editorTab
}

export function projectSessionFromPersisted(
  session: PersistedProjectSession,
): ProjectEditorSession {
  const tabs = session.tabs
    .filter(tab => !isPinnedSettingsTab(tab.path))
    .map(tabFromPersisted)
  let activeTabId = session.activeTabId
  if (activeTabId && !tabs.some(tab => tab.id === activeTabId)) activeTabId = null
  if (!activeTabId) activeTabId = tabs[0]?.id ?? null
  return { tabs, activeTabId, pendingReveal: null }
}

export function terminalFromPersisted(
  projectId: string,
  meta: PersistedProjectSession['terminals'][number],
): TerminalTab {
  return {
    id: meta.id,
    name: meta.name,
    projectId,
    cwd: meta.cwd,
    launchCommand: meta.launchCommand,
    shellKind: meta.shellKind,
    env: meta.env,
    shell: isTerminalShellId(meta.shell) ? normalizeTerminalShell(meta.shell) : undefined,
    profileId: meta.profileId,
    allowTitleRename: meta.allowTitleRename,
    runConfigId: meta.runConfigId,
    runTaskId: meta.runTaskId,
    status: 'exited',
    exitCode: null,
    awaitingRestoreSpawn: true,
  }
}
