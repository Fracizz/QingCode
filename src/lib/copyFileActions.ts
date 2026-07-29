import type { EditorView } from '@codemirror/view'
import { translate } from './i18n'
import { getEditorView } from './editorSession'
import { explorerPathsForCopyShortcut } from './explorerSelection'
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

function asPathList(pathOrPaths: string | readonly string[]): string[] {
  return typeof pathOrPaths === 'string' ? [pathOrPaths] : [...pathOrPaths]
}

/** Prefer focused explorer selection; fall back to the active editor tab. */
function pathsForCopyShortcut(): string[] {
  const fromExplorer = explorerPathsForCopyShortcut()
  if (fromExplorer.length > 0) return fromExplorer
  const tab = activeEditableTab()
  return tab?.path ? [tab.path] : []
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

/** Copy filesystem path(s) to the clipboard (Ctrl+Shift+C). Multiple → newline-joined. */
export async function copyPathAction(pathOrPaths: string | readonly string[]): Promise<void> {
  const paths = asPathList(pathOrPaths)
  if (paths.length === 0) return
  const pushToast = useProjectStore.getState().pushToast
  try {
    await copyToClipboard(paths.join('\n'))
    pushToast(
      'success',
      paths.length === 1
        ? translate('路径已复制')
        : translate('已复制 {count} 个路径', { count: paths.length }),
    )
  } catch (error) {
    pushToast('error', translate('复制路径失败: {error}', { error: String(error) }))
  }
}

/** Copy project-relative path(s) with POSIX slashes (Ctrl+Shift+Alt+C). */
export async function copyRelativePathAction(
  pathOrPaths: string | readonly string[],
): Promise<void> {
  const paths = asPathList(pathOrPaths)
  if (paths.length === 0) return
  const pushToast = useProjectStore.getState().pushToast
  const projectState = useProjectStore.getState()
  const lines: string[] = []
  for (const path of paths) {
    const project =
      findProjectForPath(projectState.projects, path) ?? projectState.currentProject
    if (!project) {
      pushToast('error', translate('无法确定该路径所属项目'))
      return
    }
    lines.push(projectRelativePath(project.path, path))
  }
  try {
    await copyToClipboard(lines.join('\n'))
    pushToast(
      'success',
      lines.length === 1
        ? translate('相对路径已复制')
        : translate('已复制 {count} 个相对路径', { count: lines.length }),
    )
  } catch (error) {
    pushToast('error', translate('复制路径失败: {error}', { error: String(error) }))
  }
}

/**
 * Copy `@project/relative#L…` file reference(s).
 * When `startLine` / `endLine` are omitted for a single path, uses L1 (explorer)
 * or the active editor selection when `path` matches the focused tab.
 * Multiple paths always use L1 each (newline-joined).
 */
export async function copyFileReferenceAction(
  pathOrPaths: string | readonly string[],
  lineRange?: { startLine: number; endLine?: number },
): Promise<void> {
  const paths = asPathList(pathOrPaths)
  if (paths.length === 0) return
  const pushToast = useProjectStore.getState().pushToast
  const projectState = useProjectStore.getState()
  const references: string[] = []

  for (const path of paths) {
    const project =
      findProjectForPath(projectState.projects, path) ?? projectState.currentProject
    if (!project) {
      pushToast('error', translate('无法确定该路径所属项目'))
      return
    }

    let startLine = lineRange?.startLine ?? 1
    let endLine = lineRange?.endLine ?? startLine

    if (!lineRange && paths.length === 1) {
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

    references.push(formatFileReference(project, path, startLine, endLine))
  }

  try {
    await copyToClipboard(references.join('\n'))
    pushToast(
      'success',
      references.length === 1
        ? translate('文件引用已复制')
        : translate('已复制 {count} 个文件引用', { count: references.length }),
    )
  } catch (error) {
    pushToast('error', translate('复制引用失败: {error}', { error: String(error) }))
  }
}

/** Ctrl+Shift+C / Ctrl+Shift+Alt+C / Alt+C — explorer selection when focused, else active tab. */
export async function copyActivePathAction(): Promise<void> {
  const paths = pathsForCopyShortcut()
  if (paths.length === 0) return
  await copyPathAction(paths)
}

export async function copyActiveRelativePathAction(): Promise<void> {
  const paths = pathsForCopyShortcut()
  if (paths.length === 0) return
  await copyRelativePathAction(paths)
}

export async function copyActiveFileReferenceAction(): Promise<void> {
  const paths = pathsForCopyShortcut()
  if (paths.length === 0) return
  await copyFileReferenceAction(paths)
}
