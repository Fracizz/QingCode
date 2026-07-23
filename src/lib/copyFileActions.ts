import type { EditorView } from '@codemirror/view'
import { translate } from './i18n'
import { getEditorView } from './editorSession'
import { explorerPathForCopyShortcut } from './explorerSelection'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import {
  copyToClipboard,
  findProjectForPath,
  formatFileReference,
  pathsEqual,
  projectRelativePath,
} from '../utils/fileReferences'

function activeEditableTab() {
  const { tabs, activeTabId } = useEditorStore.getState()
  return tabs.find(t => t.id === activeTabId) ?? null
}

/** Prefer focused explorer selection; fall back to the active editor tab. */
function pathForCopyShortcut(): string | null {
  const fromExplorer = explorerPathForCopyShortcut()
  if (fromExplorer) return fromExplorer
  return activeEditableTab()?.path ?? null
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

/** Copy project-relative path with POSIX slashes (Ctrl+Shift+Alt+C). */
export async function copyRelativePathAction(path: string): Promise<void> {
  const pushToast = useProjectStore.getState().pushToast
  const projectState = useProjectStore.getState()
  const project =
    findProjectForPath(projectState.projects, path) ?? projectState.currentProject
  if (!project) {
    pushToast('error', translate('无法确定该路径所属项目'))
    return
  }
  try {
    await copyToClipboard(projectRelativePath(project.path, path))
    pushToast('success', translate('相对路径已复制'))
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

/** Ctrl+Shift+C / Ctrl+Shift+Alt+C / Alt+C — explorer selection when focused, else active tab. */
export async function copyActivePathAction(): Promise<void> {
  const path = pathForCopyShortcut()
  if (!path) return
  await copyPathAction(path)
}

export async function copyActiveRelativePathAction(): Promise<void> {
  const path = pathForCopyShortcut()
  if (!path) return
  await copyRelativePathAction(path)
}

export async function copyActiveFileReferenceAction(): Promise<void> {
  const path = pathForCopyShortcut()
  if (!path) return
  await copyFileReferenceAction(path)
}
