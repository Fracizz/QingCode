import { safeInvoke } from './tauri'

export interface SearchFileHit {
  name: string
  path: string
  relative: string
  is_dir: boolean
}

export interface SearchFilesResult {
  hits: SearchFileHit[]
  truncated: boolean
  cancelled?: boolean
}

/** Preserve completeness metadata for remote searches without changing local IPC. */
export async function searchFiles(
  action: string,
  args: Record<string, unknown> & { root: string },
  signal?: AbortSignal,
): Promise<SearchFilesResult> {
  if (signal?.aborted) return { hits: [], truncated: false, cancelled: true }
  if (args.root.startsWith('ssh://')) {
    const requestId = crypto.randomUUID()
    const cancel = () => {
      void safeInvoke('取消文件搜索', 'cancel_ssh_file_search', { requestId }).catch(error => {
        console.warn('cancel remote file search failed:', error)
      })
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      return await safeInvoke<SearchFilesResult>(action, 'ssh_search_files_detailed', { ...args, requestId })
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  const hits = await safeInvoke<SearchFileHit[]>(action, 'search_files', args)
  return { hits, truncated: hits.length >= Number(args.limit ?? 500) }
}
