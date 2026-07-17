import { getEditorPreferences } from './editorSettings'
import { safeInvoke } from './tauri'

export type ReplacePreviewFile = {
  path: string
  name: string
  relative: string
  matchCount: number
  samples: { line: number; text: string; matchStart: number; matchEnd: number }[]
}

export type ReplacePreview = {
  query: string
  replacement: string
  ignoreCase: boolean
  files: ReplacePreviewFile[]
  matchCount: number
  truncated: boolean
}

export function buildReplacePreview(
  query: string,
  replacement: string,
  ignoreCase: boolean,
  files: {
    path: string
    name: string
    relative: string
    matches: { line: number; text: string; match_start: number; match_end: number }[]
  }[],
  matchCount: number,
  truncated: boolean,
): ReplacePreview {
  return {
    query,
    replacement,
    ignoreCase,
    matchCount,
    truncated,
    files: files.map(file => ({
      path: file.path,
      name: file.name,
      relative: file.relative,
      matchCount: file.matches.length,
      samples: file.matches.slice(0, 5).map(m => ({
        line: m.line,
        text: m.text,
        matchStart: m.match_start,
        matchEnd: m.match_end,
      })),
    })),
  }
}

function buildRegex(query: string, ignoreCase: boolean): RegExp {
  return new RegExp(query, ignoreCase ? 'giu' : 'gu')
}

export function countRegexMatches(content: string, query: string, ignoreCase: boolean): number {
  try {
    const re = buildRegex(query, ignoreCase)
    const matches = content.match(re)
    return matches?.length ?? 0
  } catch {
    return 0
  }
}

export function applyRegexReplace(
  content: string,
  query: string,
  replacement: string,
  ignoreCase: boolean,
): { next: string; count: number } {
  const re = buildRegex(query, ignoreCase)
  let count = 0
  const next = content.replace(re, () => {
    count += 1
    return replacement
  })
  return { next, count }
}

export type ReplaceApplyResult = {
  filesChanged: number
  replacements: number
  errors: string[]
}

/** Apply workspace replace after user confirms the preview. */
export async function applyWorkspaceReplace(
  preview: ReplacePreview,
  options?: {
    onProgress?: (done: number, total: number) => void
    beforeWrite?: (path: string) => Promise<void>
  },
): Promise<ReplaceApplyResult> {
  let filesChanged = 0
  let replacements = 0
  const errors: string[] = []
  const total = preview.files.length

  for (let i = 0; i < preview.files.length; i++) {
    const file = preview.files[i]
    options?.onProgress?.(i, total)
    try {
      const encoding = getEditorPreferences().encoding
      const content = await safeInvoke<string>('读取文件', 'read_file', {
        path: file.path,
        encoding,
      })
      const { next, count } = applyRegexReplace(
        content,
        preview.query,
        preview.replacement,
        preview.ignoreCase,
      )
      if (count === 0 || next === content) continue
      await options?.beforeWrite?.(file.path)
      await safeInvoke('写入文件', 'write_file', { path: file.path, content: next, encoding })
      filesChanged += 1
      replacements += count
    } catch (e) {
      errors.push(`${file.name}: ${String(e)}`)
    }
  }
  options?.onProgress?.(total, total)
  return { filesChanged, replacements, errors }
}
