import { isSshResource, safeInvoke } from './tauri'
import type {
  FileNode, FileSlice, FileStat, LineOffsetResult, RemoteFileSlice,
} from './generated/fileIpc'

export type { FileNode, FileSlice, FileStat, LineOffsetResult } from './generated/fileIpc'

/** Typed entrypoints keep native wire shapes at the IPC boundary. */
export function scanDirectoryEntries(args: {
  path: string
  workspaceRoot?: string
  excludePatterns?: string[] | null
  excludeGitIgnore?: boolean
}, action = '读取目录'): Promise<FileNode[]> {
  return safeInvoke<FileNode[]>(action, 'scan_directory', {
    ...args,
    workspaceRoot: args.workspaceRoot ?? args.path,
    excludePatterns: args.excludePatterns ?? null,
    excludeGitIgnore: args.excludeGitIgnore ?? false,
  })
}

export function getFileStat(args: { path: string }): Promise<FileStat> {
  return safeInvoke<FileStat>('读取文件信息', 'file_stat', args)
}

export async function readFileSlice(args: {
  path: string
  offset: number
  maxBytes: number
}): Promise<FileSlice> {
  if (isSshResource(args.path)) {
    const slice = await safeInvoke<RemoteFileSlice>('读取文件片段', 'read_file_slice', args)
    return {
      offset: slice.offset,
      len: slice.nextOffset - slice.offset,
      text: slice.content,
      eof: slice.eof,
      file_size: slice.fileSize,
    }
  }
  return safeInvoke<FileSlice>('读取文件片段', 'read_file_slice', args)
}

export function findLineOffset(args: { path: string; line: number }): Promise<LineOffsetResult> {
  return safeInvoke<LineOffsetResult>('定位行偏移', 'find_line_offset', args)
}
