export type OpenFileErrorKind =
  | 'binary'
  | 'encoding'
  | 'too-large'
  | 'folder'
  | 'access'
  | 'generic'

export function parseOpenFileError(error: unknown): { message: string; kind: OpenFileErrorKind } {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error:\s*/i, '').trim() || raw

  if (message.includes('无法打开文件夹') || message.includes('无法打开目录')) {
    return { message, kind: 'folder' }
  }
  if (message.includes('超过') && message.includes('MB')) {
    return { message, kind: 'too-large' }
  }
  if (message.includes('暂不支持打开') && message.includes('格式')) {
    return { message, kind: 'binary' }
  }
  if (message.includes('非 UTF-8') || message.includes('非文本')) {
    return { message, kind: 'encoding' }
  }
  if (message.startsWith('无法访问')) {
    return { message, kind: 'access' }
  }
  if (
    message.startsWith('暂不支持')
    || message.startsWith('无法打开')
    || message.startsWith('读取文件失败')
  ) {
    return { message, kind: 'generic' }
  }
  return { message: `打开文件失败：${message}`, kind: 'generic' }
}

/** VS Code–style headline for the open-error editor pane. */
export function openFileErrorTitle(kind: OpenFileErrorKind): string {
  switch (kind) {
    case 'binary':
    case 'encoding':
      return '无法在文本编辑器中显示此文件，因为它可能是二进制文件或使用了不支持的文本编码。'
    case 'too-large':
      return '文件过大（超过 500MB），无法打开。'
    case 'folder':
      return '无法在文本编辑器中打开文件夹。'
    case 'access':
      return '无法访问此文件，它可能已被移动、删除或没有读取权限。'
    default:
      return '无法打开编辑器。'
  }
}

export function isOpenErrorTab(tab: { openError?: string }): boolean {
  return Boolean(tab.openError)
}

export function isLoadingTab(tab: {
  loading?: boolean
  content?: string
  openError?: string
  viewMode?: 'edit' | 'view'
  /** Set after a successful disk open; kept when plain tabs clear the Zustand buffer. */
  fileSize?: number
  diskMtime?: number | null
}): boolean {
  if (tab.openError) return false
  // View-mode tabs never hold full `content`; only the progressive spinner matters.
  if (tab.viewMode === 'view') return Boolean(tab.loading)
  if (tab.loading) return true
  // Plain-profile tabs clear `content` after bind (CM owns the buffer) but keep
  // fileSize/diskMtime — that must not look like "still opening".
  if (tab.content !== undefined) return false
  return tab.fileSize === undefined && tab.diskMtime === undefined
}

/**
 * Whether App / loadMissingTabContents should (re)hydrate this tab from disk.
 * Distinct from {@link isLoadingTab}: plain tabs may have `content === undefined`
 * after bind without needing another read_file.
 */
export function tabNeedsDiskContent(tab: {
  loading?: boolean
  content?: string
  openError?: string
  viewMode?: 'edit' | 'view'
  fileSize?: number
  diskMtime?: number | null
}): boolean {
  if (tab.openError || tab.loading) return false
  if (tab.viewMode === 'view') return tab.fileSize === undefined
  // Draft-restored buffers already have content; only mtime may be missing.
  if (tab.content !== undefined) return tab.diskMtime === undefined
  // Session restore / progressive open: never finished a disk populate.
  return tab.fileSize === undefined || tab.diskMtime === undefined
}

export function isViewOnlyTab(tab: { viewMode?: 'edit' | 'view'; openError?: string }): boolean {
  return tab.viewMode === 'view' && !tab.openError
}
