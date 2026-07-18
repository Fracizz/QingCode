import { getLiveEditorContent, flushLiveEditorContent } from './editorSession'
import { getEditorPreferences } from './editorSettings'
import { resolveReadEncoding } from './fileEncoding'
import { translate } from './i18n'
import { isTauri, safeInvoke } from './tauri'
import { useCompareStore } from '../store/compareStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { pathsEqual } from '../utils/fileReferences'

/** Open a side-by-side compare of the working copy vs `git show HEAD:path`. */
export async function openGitCompareWithHead(filePath: string): Promise<void> {
  if (!isTauri()) {
    useProjectStore.getState().pushToast('error', translate('当前环境无法比较 Git 版本'))
    return
  }

  const editor = useEditorStore.getState()
  const tab = editor.tabs.find(t => pathsEqual(t.path, filePath))
    ?? Object.values(editor.projectSessions)
      .flatMap(s => s.tabs)
      .find(t => pathsEqual(t.path, filePath))

  let leftContent: string
  if (tab && !tab.loading && !tab.openError && tab.viewMode !== 'view') {
    flushLiveEditorContent(tab.id)
    leftContent = getLiveEditorContent(tab.id) ?? tab.content ?? ''
  } else {
    try {
      const encoding = tab?.encoding ?? await resolveReadEncoding(
        filePath,
        getEditorPreferences().encoding,
      )
      leftContent = await safeInvoke<string>('读取文件', 'read_file', { path: filePath, encoding })
    } catch (e) {
      useProjectStore.getState().pushToast(
        'error',
        translate('读取文件失败: {error}', { error: String(e) }),
      )
      return
    }
  }

  let headContent: string | null
  try {
    headContent = await safeInvoke<string | null>('读取 Git HEAD 文件', 'git_show_head_file', {
      path: filePath,
    })
  } catch (e) {
    useProjectStore.getState().pushToast(
      'error',
      translate('无法读取 Git HEAD 版本: {error}', { error: String(e) }),
    )
    return
  }

  if (headContent == null) {
    useProjectStore.getState().pushToast('info', translate('该文件不在 Git HEAD 中（可能是新文件）'))
    return
  }

  useCompareStore.getState().openCompare({
    path: filePath,
    leftTitle: translate('工作区版本'),
    rightTitle: translate('Git HEAD'),
    leftContent,
    rightContent: headContent,
    onClose: () => useCompareStore.getState().closeCompare(),
  })
}
