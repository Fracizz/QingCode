import type { FileEncoding } from './editorSettings'

/** Status-bar encoding picker options (aligned with `files.encoding` / FileEncoding). */
export const FILE_ENCODING_OPTIONS: { value: FileEncoding; label: string }[] = [
  { value: 'utf8', label: 'UTF-8' },
  { value: 'utf8bom', label: 'UTF-8 with BOM' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
]

export function formatFileEncoding(encoding?: string) {
  if (!encoding) return 'UTF-8'
  return FILE_ENCODING_OPTIONS.find(option => option.value === encoding)?.label ?? encoding.toUpperCase()
}
