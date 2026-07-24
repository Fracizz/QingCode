import { useEditorStore } from '../../store/editorStore'
import { useDefinitionPickerStore } from '../../store/definitionPickerStore'
import { useProjectStore } from '../../store/projectStore'
import { translate } from '../i18n'
import { pathsEqual } from '../../utils/fileReferences'
import type { DefinitionTarget } from './types'

export async function navigateToDefinition(target: DefinitionTarget): Promise<void> {
  const store = useEditorStore.getState()
  const active = store.tabs.find(t => t.id === store.activeTabId)
  const sameFile = Boolean(active && pathsEqual(active.path, target.path))

  if (sameFile) {
    store.prepareNavigationJump({
      path: target.path,
      line: target.line,
      column: target.column,
    })
    useEditorStore.setState({
      pendingReveal: {
        path: target.path,
        line: target.line,
        column: target.column,
        from: target.from,
      },
    })
    return
  }

  // openFile records navigation history when line is provided.
  await store.openFile(target.path, target.line, target.column)
  if (target.from != null) {
    useEditorStore.setState({
      pendingReveal: {
        path: target.path,
        line: target.line,
        column: target.column,
        from: target.from,
      },
    })
  }
}

export async function presentDefinitionResults(targets: DefinitionTarget[]): Promise<void> {
  if (targets.length === 0) {
    useProjectStore.getState().pushToast('info', translate('未找到定义'))
    return
  }
  if (targets.length === 1) {
    await navigateToDefinition(targets[0]!)
    return
  }
  useDefinitionPickerStore.getState().openWith(targets)
}
