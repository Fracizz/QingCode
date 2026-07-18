import { isTauri, safeInvoke } from './tauri'
import type { FileEncoding, WritableFileEncoding } from './editorSettings'

/** Encodings that can be written to disk. */
export const FILE_ENCODING_OPTIONS: { value: WritableFileEncoding; label: string }[] = [
  { value: 'utf8', label: 'UTF-8' },
  { value: 'utf8bom', label: 'UTF-8 with BOM' },
  { value: 'utf16le', label: 'UTF-16 LE' },
  { value: 'utf16be', label: 'UTF-16 BE' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
]

/** Options for re-reading an existing file without changing its bytes. */
export const REOPEN_FILE_ENCODING_OPTIONS: { value: FileEncoding; label: string }[] = [
  { value: 'auto', label: '自动检测' },
  ...FILE_ENCODING_OPTIONS,
]

export function formatFileEncoding(encoding?: string) {
  if (!encoding) return 'UTF-8'
  return FILE_ENCODING_OPTIONS.find(option => option.value === encoding)?.label ?? encoding.toUpperCase()
}

/** Resolve the configured read mode to an actual encoding recorded on the tab. */
export async function resolveReadEncoding(
  path: string,
  configured: FileEncoding,
): Promise<WritableFileEncoding> {
  if (configured !== 'auto') return configured
  if (!isTauri()) return 'utf8'
  return safeInvoke<WritableFileEncoding>('检测文件编码', 'detect_file_encoding', { path })
}
