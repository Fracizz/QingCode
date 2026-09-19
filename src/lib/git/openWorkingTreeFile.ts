import { translate } from '../i18n'
import { isTauri, safeInvoke } from '../tauri'
import { useEditorStore } from '../../store/editorStore'
import { useProjectStore } from '../../store/projectStore'
import { useUIStore } from '../../store/uiStore'

export type OpenWorkingTreeFileResult = 'opened' | 'revealed-directory' | 'missing'

/** Working-tree file is gone when Git status includes `D` (porcelain or name-status). */
export function canOpenGitPathInEditor(status: string): boolean {
  return !status.includes('D')
}

export async function probeWorkingTreePath(
  absolutePath: string
): Promise<'file' | 'directory' | 'missing'> {
  if (!isTauri()) return 'missing'
  try {
    const stat = await safeInvoke<{ size: number; is_dir: boolean }>('读取文件信息', 'file_stat', {
      path: absolutePath,
    })
    return stat.is_dir ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

/**
 * Open the working-tree file in the editor (not a Git snapshot).
 * Missing / deleted paths toast and do not create an empty tab.
 */
export async function openWorkingTreeFile(options: {
  absolutePath: string
  line?: number
  column?: number
  status?: string
  looksLikeDirectory?: boolean
}): Promise<OpenWorkingTreeFileResult> {
  const { absolutePath, line, column, status, looksLikeDirectory } = options
  const pushToast = useProjectStore.getState().pushToast

  if ((status && !canOpenGitPathInEditor(status)) || looksLikeDirectory) {
    if (looksLikeDirectory) {
      useUIStore.getState().setView('explorer')
      void useProjectStore.getState().revealFileInTree(absolutePath, { force: true })
      return 'revealed-directory'
    }
    pushToast('info', translate('工作区中不存在该文件'))
    return 'missing'
  }

  const kind = await probeWorkingTreePath(absolutePath)
  if (kind === 'directory') {
    useUIStore.getState().setView('explorer')
    void useProjectStore.getState().revealFileInTree(absolutePath, { force: true })
    return 'revealed-directory'
  }
  if (kind === 'missing') {
    pushToast('info', translate('工作区中不存在该文件'))
    return 'missing'
  }

  useUIStore.getState().setView('explorer')
  await useEditorStore.getState().openFile(absolutePath, line, column)
  return 'opened'
}
