import { EditorState } from '@codemirror/state'
import { loadLanguageSupport } from '../editorLanguages'
import { safeInvoke } from '../tauri'
import { getLiveEditorContent } from '../editorSession'
import { useEditorStore } from '../../store/editorStore'
import { languageIdForPath } from './pathUtils'
import { normalizePath } from '../../utils/fileReferences'

/** Prefer open-tab / live buffer content; otherwise read from disk. */
export async function readFileContent(path: string): Promise<string | null> {
  const norm = normalizePath(path)
  const tabs = useEditorStore.getState().tabs
  const open = tabs.find(t => normalizePath(t.path).toLowerCase() === norm.toLowerCase())
  if (open) {
    if (open.loading || open.openError) return null
    const live = getLiveEditorContent(open.id)
    if (live != null) return live
    return open.content ?? null
  }
  try {
    return await safeInvoke<string>('读取文件', 'read_file', { path })
  } catch {
    return null
  }
}

export async function editorStateForFile(path: string): Promise<EditorState | null> {
  const content = await readFileContent(path)
  if (content == null) return null
  const languageId = languageIdForPath(path)
  const lang = await loadLanguageSupport(languageId)
  return EditorState.create({
    doc: content,
    extensions: lang ? [lang] : [],
  })
}
