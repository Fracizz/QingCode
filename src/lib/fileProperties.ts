import { parentPath } from '../utils/fileReferences'
import { safeInvoke } from './tauri'

type FileStat = { size: number; is_dir: boolean }

export type FolderEntryCounts = {
  fileCount: number
  folderCount: number
  totalSize: number
}

export type FileProperties = {
  name: string
  path: string
  location: string
  kind: 'file' | 'folder'
  size?: number
  createdMs: number | null
  modifiedMs: number | null
}

/** Containing folder path (IDEA / Windows style), not the item's own full path. */
export function getPropertiesLocation(path: string): string {
  return parentPath(path)
}

export async function loadFileProperties(
  path: string,
  name: string,
  isDir: boolean,
): Promise<FileProperties> {
  const [stat, createdMs, modifiedMs] = await Promise.all([
    safeInvoke<FileStat>('读取文件信息', 'file_stat', { path }),
    safeInvoke<number | null>('读取创建时间', 'file_ctime', { path }).catch(() => null),
    safeInvoke<number | null>('读取修改时间', 'file_mtime', { path }).catch(() => null),
  ])
  const kind = stat.is_dir || isDir ? 'folder' : 'file'
  return {
    name,
    path,
    location: getPropertiesLocation(path),
    kind,
    size: kind === 'file' ? stat.size : undefined,
    createdMs,
    modifiedMs,
  }
}

export async function loadFolderEntryCounts(path: string): Promise<FolderEntryCounts> {
  const counts = await safeInvoke<{
    fileCount: number
    folderCount: number
    totalSize: number
  }>('读取文件夹条目数', 'directory_entry_counts', { path })
  return {
    fileCount: counts.fileCount,
    folderCount: counts.folderCount,
    totalSize: counts.totalSize,
  }
}

export function formatEntryCount(count: number | null | undefined, locale: string): string {
  if (count == null) return '—'
  const tag = locale === 'zh-CN' ? 'zh-CN' : 'en'
  return new Intl.NumberFormat(tag).format(count)
}

export function formatFileTime(ms: number | null, locale: string): string {
  if (ms == null) return '—'
  const tag = locale === 'zh-CN' ? 'zh-CN' : 'en'
  return new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(ms))
}

/** @deprecated Use {@link formatFileTime}. */
export function formatModifiedTime(ms: number | null, locale: string): string {
  return formatFileTime(ms, locale)
}
