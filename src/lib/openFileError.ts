export type OpenFileErrorKind =
  | 'binary'
  | 'encoding'
  | 'too-large'
  | 'folder'
  | 'access'
  | 'generic'

/**
 * Decoder plumbing that must never reach the UI verbatim.
 * `binary content` comes from `file_encoding::detect`, `unsupported text
 * encoding` from the same module's fallback path.
 */
const DECODE_JARGON = /binary content|unsupported text encoding/gi

/** Backend wording meaning "these bytes are not text at all". */
const BINARY_PAYLOAD = /binary content|二进制内容/i

const DECODE_FAILURE =
  /非 UTF-8|非文本|无法识别文件编码|不支持的文本编码|无法按 \S+ 解码|解码失败/

/** Extension → file-type label (i18n key) for the open-error pane. */
const BINARY_TYPE_GROUPS: { label: string; exts: string[] }[] = [
  { label: '图片', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'tif', 'tiff'] },
  { label: 'PDF 文档', exts: ['pdf'] },
  { label: '压缩包', exts: ['zip', 'gz', 'tgz', 'tar', '7z', '7zip', 'rar', 'bz2', 'xz'] },
  {
    label: '可执行文件或编译产物',
    exts: ['exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'class', 'pyc', 'pyo', 'pyd', 'o', 'obj'],
  },
  { label: '字体文件', exts: ['woff', 'woff2', 'ttf', 'otf', 'eot'] },
  { label: '音视频文件', exts: ['mp3', 'mp4', 'avi', 'mov', 'mkv', 'flac', 'wav', 'webm'] },
  {
    label: 'Office 文档',
    exts: [
      'xlsx', 'xlsm', 'xls', 'docx', 'doc', 'pptx', 'ppt',
      'odt', 'ods', 'odp', 'numbers', 'pages', 'key',
    ],
  },
  { label: '数据库文件', exts: ['sqlite', 'sqlite3', 'db', 'mdb'] },
]

/** Lowercased extension without the dot (`''` when there is none). */
export function fileExtension(path?: string): string {
  if (!path) return ''
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/** `.png` for display, `''` when the name carries no extension. */
export function fileExtensionLabel(path?: string): string {
  const ext = fileExtension(path)
  return ext ? `.${ext}` : ''
}

/** Localized file-type label (i18n key) for a binary path, `null` when unknown. */
export function binaryFileTypeLabel(path?: string): string | null {
  const ext = fileExtension(path)
  if (!ext) return null
  return BINARY_TYPE_GROUPS.find(group => group.exts.includes(ext))?.label ?? null
}

/**
 * Whether the path is a format we refuse to decode as text.
 * Mirrors `src-tauri/src/binary_ext.rs`; used only to disambiguate messages,
 * never to gate a read (the backend stays authoritative).
 */
export function isBinaryExtension(path?: string): boolean {
  return binaryFileTypeLabel(path) !== null
}

/** Replace decoder plumbing with wording the user can act on. */
function humanizeDecodeFailure(message: string): string {
  return message
    .replace(/检测远程文件编码失败[：:]\s*binary content/i, '远程文件包含二进制内容，不是文本文件')
    .replace(DECODE_JARGON, match =>
      match.toLowerCase() === 'binary content' ? '二进制内容' : '不支持的文本编码'
    )
}

export function parseOpenFileError(
  error: unknown,
  path?: string
): { message: string; kind: OpenFileErrorKind } {
  const raw = error instanceof Error ? error.message : String(error)
  const message = humanizeDecodeFailure(raw.replace(/^Error:\s*/i, '').trim() || raw)

  if (message.includes('无法打开文件夹') || message.includes('无法打开目录')) {
    return { message, kind: 'folder' }
  }
  if (message.includes('超过') && message.includes('MB')) {
    return { message, kind: 'too-large' }
  }
  if (/暂不支持.*打开/.test(message) && message.includes('格式')) {
    return { message, kind: 'binary' }
  }
  if (BINARY_PAYLOAD.test(message)) {
    // A .png over SFTP is binary for sure; an extensionless / .sh file that the
    // decoder rejects may still be text behind a DLP driver, so keep the
    // read-only preview escape hatch for those.
    return { message, kind: isBinaryExtension(path) ? 'binary' : 'encoding' }
  }
  if (DECODE_FAILURE.test(message)) {
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
export function openFileErrorTitle(
  kind: OpenFileErrorKind,
  options: { remote?: boolean } = {}
): string {
  switch (kind) {
    case 'binary':
      return '无法在编辑器中以文本方式打开此文件。'
    case 'encoding':
      // Transparent-encryption drivers are a local-Windows problem; over SSH the
      // bytes simply do not decode, so do not blame DLP there.
      return options.remote
        ? '文件内容无法按当前编码解码。'
        : '文件内容无法解码；若文件受加密软件保护，当前进程可能读取到了密文字节，请重试。'
    case 'too-large':
      // The exact limit differs per path (100MB edit / 500MB viewer / remote),
      // and the backend message already carries it.
      return '文件过大，无法在文本编辑器中打开。'
    case 'folder':
      return '无法在文本编辑器中打开文件夹。'
    case 'access':
      return '无法访问此文件，它可能已被移动、删除或没有读取权限。'
    default:
      return '无法打开编辑器。'
  }
}

/** Retry only helps for failures that may be transient. */
export function canRetryOpen(kind: OpenFileErrorKind): boolean {
  return kind === 'encoding' || kind === 'access' || kind === 'generic'
}

export function isOpenErrorTab(tab: { openError?: string }): boolean {
  return Boolean(tab.openError)
}

/**
 * Whether the error pane may offer a lossy read-only preview (VS Code "Open Anyway").
 *
 * Only for decode failures: those files are usually text that carries a stray
 * NUL / marker block (DLP agents, generators). Extension-blacklisted formats
 * stay blocked because the slice viewer rejects them as well.
 */
export function canPreviewAnyway(kind: OpenFileErrorKind): boolean {
  return kind === 'encoding'
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
