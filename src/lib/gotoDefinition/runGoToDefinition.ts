import { getEditorView } from '../editorSession'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { isLoadingTab, isOpenErrorTab } from '../openFileError'
import { resolveDefinitions } from './resolve'
import { presentDefinitionResults } from './navigate'
import { translate } from '../i18n'

/** Command / F12 entry: resolve definition at the current caret. */
export async function runGoToDefinition(): Promise<void> {
  const { tabs, activeTabId } = useEditorStore.getState()
  const tab = tabs.find(t => t.id === activeTabId)
  if (!tab || isOpenErrorTab(tab) || isLoadingTab(tab)) {
    useProjectStore.getState().pushToast('info', translate('未找到定义'))
    return
  }
  const view = getEditorView(tab.id)
  if (!view) {
    useProjectStore.getState().pushToast('info', translate('未找到定义'))
    return
  }
  const projectRoots = useProjectStore.getState().projects.map(p => p.path)
  const pos = view.state.selection.main.head
  const targets = await resolveDefinitions({
    state: view.state,
    pos,
    filePath: tab.path,
    languageId: tab.language ?? 'plain',
    projectRoots,
  })
  await presentDefinitionResults(targets)
}

/** Used by Ctrl/Cmd+click with an explicit document position. */
export async function runGoToDefinitionAt(pos: number): Promise<void> {
  const { tabs, activeTabId } = useEditorStore.getState()
  const tab = tabs.find(t => t.id === activeTabId)
  if (!tab || isOpenErrorTab(tab) || isLoadingTab(tab)) return
  const view = getEditorView(tab.id)
  if (!view) return
  const projectRoots = useProjectStore.getState().projects.map(p => p.path)
  const targets = await resolveDefinitions({
    state: view.state,
    pos,
    filePath: tab.path,
    languageId: tab.language ?? 'plain',
    projectRoots,
  })
  await presentDefinitionResults(targets)
}
