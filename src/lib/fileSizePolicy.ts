/** Product size policy for text open / edit / view (bytes). */

/** Soft toast + delay/skip language packs for editable files at/above this size. */
export const EDIT_WARN_BYTES = 2 * 1024 * 1024

/**
 * Above this size (within the edit band): VS-style degraded edit —
 * no highlighting, wrap, fold, markdown preview, or full search match counts.
 */
export const EDIT_DEGRADED_BYTES = 5 * 1024 * 1024

/**
 * Default CodeMirror buffer edit cap (full/degraded profiles).
 * Overridable per extension via `files.maxSizeForEdit` (clamped to PLAIN_EDIT_MAX_BYTES).
 */
export const EDIT_MAX_BYTES = 20 * 1024 * 1024

/**
 * Plain-text CodeMirror full-buffer edit hard cap.
 * Matches Rust `MAX_EDITOR_FILE_SIZE` for `read_file` / `write_file`.
 * Intentionally not raised for log-class files (WebView memory safety).
 */
export const PLAIN_EDIT_MAX_BYTES = 100 * 1024 * 1024

/** Pure read-only slice viewer hard cap (matches Rust `MAX_VIEWER_FILE_SIZE`). */
export const VIEW_MAX_BYTES = 500 * 1024 * 1024

/** @deprecated Use PLAIN_EDIT_MAX_BYTES — kept as alias for older call sites. */
export const VIEW_PATCH_MAX_BYTES = PLAIN_EDIT_MAX_BYTES

/** Max UTF-8 bytes allowed in a single range-replace patch (legacy backend). */
export const REPLACE_FRAGMENT_MAX_BYTES = 1 * 1024 * 1024

export type FileOpenTier = 'edit' | 'edit-plain' | 'view' | 'reject'

/** Runtime CodeMirror performance profile within editable tiers. */
export type EditorPerfProfile = 'full' | 'degraded' | 'plain'

/** Pattern → max bytes (or size string) for the rich/degraded edit band. */
export type MaxSizeForEditMap = Record<string, number | string>

/** Built-in defaults for `files.maxSizeForEdit` (bytes). */
export const DEFAULT_MAX_SIZE_FOR_EDIT: MaxSizeForEditMap = {
  '*': EDIT_MAX_BYTES,
  // Log-class text: allow richer CodeMirror edit up to 50MB (still ≤ plain 100MB hard cap).
  '*.log': 50 * 1024 * 1024,
  '*.txt': 50 * 1024 * 1024,
  '*.out': 50 * 1024 * 1024,
  '*.err': 50 * 1024 * 1024,
}

let activeMaxSizeForEdit: MaxSizeForEditMap = { ...DEFAULT_MAX_SIZE_FOR_EDIT }

/** Called when effective settings are loaded / saved. */
export function setActiveMaxSizeForEdit(rules: MaxSizeForEditMap) {
  activeMaxSizeForEdit = { ...rules }
}

export function getActiveMaxSizeForEdit(): MaxSizeForEditMap {
  return activeMaxSizeForEdit
}

/** Parse bytes from a number or strings like `20MB`, `50m`, `1024KB`. */
export function parseSizeToBytes(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    return Math.floor(value)
  }
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(b|byte|bytes|k|kb|ki|kib|m|mb|mi|mib|g|gb|gi|gib)?$/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return null
  const unit = (m[2] ?? 'b').toLowerCase()
  const mul =
    unit === 'b' || unit === 'byte' || unit === 'bytes'
      ? 1
      : unit === 'k' || unit === 'kb' || unit === 'ki' || unit === 'kib'
        ? 1024
        : unit === 'm' || unit === 'mb' || unit === 'mi' || unit === 'mib'
          ? 1024 * 1024
          : unit === 'g' || unit === 'gb' || unit === 'gi' || unit === 'gib'
            ? 1024 * 1024 * 1024
            : 1
  return Math.floor(n * mul)
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function patternScore(pattern: string): number {
  const p = pattern.replace(/\\/g, '/').trim()
  if (p === '*' || p === '**/*') return 0
  if (/^(?:\*\*\/)?\*\.\{[^}]+\}$/.test(p)) return 20
  if (/^(?:\*\*\/)?\*\.[A-Za-z0-9_.]+$/.test(p)) return 30
  if (!p.includes('*') && !p.includes('/')) return 100
  if (p.includes('*')) return 10
  return 50
}

/** Match VS Code–style simple globs against a file path (basename-focused). */
export function matchFileSizePattern(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, '/').trim()
  if (!p) return false
  const name = basename(filePath)
  const lowerName = name.toLowerCase()

  if (p === '*' || p === '**/*') return true

  const brace = p.match(/^(?:\*\*\/)?\*\.\{([^}]+)\}$/)
  if (brace) {
    return brace[1]
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .some(ext => lowerName.endsWith(ext.startsWith('.') ? ext : `.${ext}`))
  }

  const starExt = p.match(/^(?:\*\*\/)?\*(\.[A-Za-z0-9_.]+)$/)
  if (starExt) return lowerName.endsWith(starExt[1].toLowerCase())

  if (!p.includes('*') && !p.includes('/')) {
    return lowerName === p.toLowerCase()
  }

  if (p.startsWith('*') && !p.slice(1).includes('*')) {
    return lowerName.endsWith(p.slice(1).toLowerCase())
  }

  return false
}

/**
 * Resolve the rich/degraded edit budget for a path from `files.maxSizeForEdit`.
 * Always clamped to `[1, PLAIN_EDIT_MAX_BYTES]` (plain/view/reject caps stay global).
 */
export function resolveEditMaxBytes(
  filePath: string,
  rules: MaxSizeForEditMap = activeMaxSizeForEdit,
): number {
  let bestScore = -1
  let best = EDIT_MAX_BYTES
  for (const [pattern, raw] of Object.entries(rules)) {
    if (!matchFileSizePattern(pattern, filePath)) continue
    const score = patternScore(pattern)
    const bytes = parseSizeToBytes(raw)
    if (bytes == null) continue
    if (score >= bestScore) {
      bestScore = score
      best = bytes
    }
  }
  return Math.min(PLAIN_EDIT_MAX_BYTES, Math.max(1, Math.floor(best)))
}

export function parseMaxSizeForEditMap(value: unknown): MaxSizeForEditMap {
  const base: MaxSizeForEditMap = { ...DEFAULT_MAX_SIZE_FOR_EDIT }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base
  for (const [pattern, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = pattern.trim()
    if (!key) continue
    const bytes = parseSizeToBytes(raw)
    if (bytes == null) continue
    base[key] = Math.min(PLAIN_EDIT_MAX_BYTES, Math.max(1, Math.floor(bytes)))
  }
  return base
}

export function fileOpenTier(
  sizeBytes: number,
  editMaxBytes: number = EDIT_MAX_BYTES,
): FileOpenTier {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'reject'
  const editMax = Math.min(PLAIN_EDIT_MAX_BYTES, Math.max(1, Math.floor(editMaxBytes)))
  if (sizeBytes <= editMax) return 'edit'
  if (sizeBytes <= PLAIN_EDIT_MAX_BYTES) return 'edit-plain'
  if (sizeBytes <= VIEW_MAX_BYTES) return 'view'
  return 'reject'
}

export function editorPerfProfile(
  sizeBytes: number,
  editMaxBytes: number = EDIT_MAX_BYTES,
): EditorPerfProfile {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'full'
  const editMax = Math.min(PLAIN_EDIT_MAX_BYTES, Math.max(1, Math.floor(editMaxBytes)))
  if (sizeBytes > editMax) return 'plain'
  if (sizeBytes >= EDIT_DEGRADED_BYTES) return 'degraded'
  return 'full'
}

/** Prefer on-disk size; fall back to content length (UTF-16 units ≈ ASCII bytes). */
export function editorPerfProfileForTab(tab: {
  fileSize?: number
  content?: string
  path?: string
}): EditorPerfProfile {
  const editMax = tab.path ? resolveEditMaxBytes(tab.path) : EDIT_MAX_BYTES
  if (tab.fileSize != null && Number.isFinite(tab.fileSize)) {
    return editorPerfProfile(tab.fileSize, editMax)
  }
  return editorPerfProfile(tab.content?.length ?? 0, editMax)
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
