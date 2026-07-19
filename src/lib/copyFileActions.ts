import type { EditorView } from '@codemirror/view'
import { translate } from './i18n'
import { getEditorView } from './editorSession'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import {
  copyToClipboard,
  findProjectForPath,
  formatFileReference,
  pathsEqual,
} from '../utils/fileReferences'

function activeEditableTab() {
  const { tabs, activeTabId } = useEditorStore.getState()
  return tabs.find(t => t.id === activeTabId) ?? null
}

function selectionLineRange(view: EditorView) {
  const selection = view.state.selection.main
  const startLine = view.state.doc.lineAt(selection.from).number
  const endPosition = selection.empty
    ? selection.head
    : Math.max(selection.from, selection.to - 1)
  const endLine = view.state.doc.lineAt(endPosition).number
  return { startLine, endLine }
}

/** Copy a filesystem path to the clipboard (Ctrl+Shift+C). */
export async function copyPathAction(path: string): Promise<void> {
  const pushToast = useProjectStore.getState().pushToast
  try {
    await copyToClipboard(path)
    pushToast('success', translate('路径已复制'))
  } catch (error) {
    pushToast('error', translate('复制路径失败: {error}', { error: String(error) }))
  }
}

/**
 * Copy an `@project/relative#L…` file reference.
 * When `startLine` / `endLine` are omitted, uses L1 (explorer) or the
 * active editor selection when `path` matches the focused tab.
 */
export async function copyFileReferenceAction(
  path: string,
  lineRange?: { startLine: number; endLine?: number },
): Promise<void> {
  const pushToast = useProjectStore.getState().pushToast
  const projectState = useProjectStore.getState()
  const project =
    findProjectForPath(projectState.projects, path) ?? projectState.currentProject
  if (!project) {
    pushToast('error', translate('无法确定该路径所属项目'))
    return
  }

  let startLine = lineRange?.startLine ?? 1
  let endLine = lineRange?.endLine ?? startLine

  if (!lineRange) {
    const tab = activeEditableTab()
    if (tab && pathsEqual(tab.path, path)) {
      const view = getEditorView(tab.id)
      if (view) {
        const range = selectionLineRange(view)
        startLine = range.startLine
        endLine = range.endLine
      }
    }
  }

  const reference = formatFileReference(project, path, startLine, endLine)
  try {
    await copyToClipboard(reference)
    pushToast('success', translate('文件引用已复制'))
  } catch (error) {
    pushToast('error', translate('复制引用失败: {error}', { error: String(error) }))
  }
}

/** Ctrl+Shift+C / Alt+C for the active editor tab (app-level keybindings). */
export async function copyActivePathAction(): Promise<void> {
  const tab = activeEditableTab()
  if (!tab?.path) return
  await copyPathAction(tab.path)
}

export async function copyActiveFileReferenceAction(): Promise<void> {
  const tab = activeEditableTab()
  if (!tab?.path) return
  await copyFileReferenceAction(tab.path)
}
