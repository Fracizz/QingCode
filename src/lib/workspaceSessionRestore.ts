import { clearDraft, getDraft } from './draftRecovery'
import type {
  PersistedEditorTab,
  PersistedProjectSession,
} from './workspaceSessionPersist'
import { isTerminalShellId, normalizeTerminalShell } from '@/lib/terminal/terminalShell'
import type { ProjectEditorSession } from '../store/editorStore'
import type { EditorTab, TerminalTab } from '../types'
import { guessLanguage, isPinnedSettingsTab, tabNameFromPath } from '../utils/editorHelpers'

export function tabFromPersisted(tab: PersistedEditorTab): EditorTab {
  const draft = tab.dirty ? getDraft(tab.path) : null
  if (tab.dirty && draft) clearDraft(tab.path)

  const readOnly = tab.viewMode === 'view' || tab.viewMode === 'image'
  const dirty = tab.dirty && !!draft
  const editorTab: EditorTab = {
    id: tab.id,
    path: tab.path,
    name: tab.name || tabNameFromPath(tab.path),
    dirty: readOnly ? false : dirty,
    language: tab.language || guessLanguage(tab.path),
    viewMode: readOnly ? tab.viewMode : 'edit',
  }
  if (draft && !readOnly) editorTab.content = draft.content
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
    pane: meta.pane,
    allowTitleRename: meta.allowTitleRename,
    runConfigId: meta.runConfigId,
    runTaskId: meta.runTaskId,
    persistent: meta.persistent,
    ptyId: meta.ptyId,
    connectionId: meta.connectionId,
    status: 'exited',
    exitCode: meta.endedAt ? meta.exitCode ?? null : null,
    endedAt: meta.endedAt,
    awaitingRestoreSpawn: !meta.endedAt,
  }
}
