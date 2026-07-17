export const FILE_ENCODING_OPTIONS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-8-bom', label: 'UTF-8 BOM' },
  { value: 'utf-16le-bom', label: 'UTF-16 LE BOM' },
  { value: 'utf-16be-bom', label: 'UTF-16 BE BOM' },
  { value: 'gbk', label: 'GBK' },
] as const

export function formatFileEncoding(encoding?: string) {
  if (!encoding) return 'UTF-8'
  return FILE_ENCODING_OPTIONS.find(option => option.value === encoding)?.label ?? encoding.toUpperCase()
}
