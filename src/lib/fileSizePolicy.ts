/** Product size policy for text open / edit / view (bytes). */

/** Soft toast + delay/skip language packs for editable files at/above this size. */
export const EDIT_WARN_BYTES = 2 * 1024 * 1024

/**
 * Above this size (within the edit band): VS-style degraded edit —
 * no highlighting, wrap, fold, markdown preview, or full search match counts.
 */
export const EDIT_DEGRADED_BYTES = 5 * 1024 * 1024

/**
 * CodeMirror buffer edit with full/degraded profiles (matches Rust plain-edit
 * path for sizes above this → `edit-plain`).
 */
export const EDIT_MAX_BYTES = 20 * 1024 * 1024

/**
 * Plain-text CodeMirror full-buffer edit hard cap.
 * Matches Rust `MAX_EDITOR_FILE_SIZE` for `read_file` / `write_file`.
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

export function fileOpenTier(sizeBytes: number): FileOpenTier {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'reject'
  if (sizeBytes <= EDIT_MAX_BYTES) return 'edit'
  if (sizeBytes <= PLAIN_EDIT_MAX_BYTES) return 'edit-plain'
  if (sizeBytes <= VIEW_MAX_BYTES) return 'view'
  return 'reject'
}

export function editorPerfProfile(sizeBytes: number): EditorPerfProfile {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'full'
  if (sizeBytes > EDIT_MAX_BYTES) return 'plain'
  if (sizeBytes >= EDIT_DEGRADED_BYTES) return 'degraded'
  return 'full'
}

/** Prefer on-disk size; fall back to content length (UTF-16 units ≈ ASCII bytes). */
export function editorPerfProfileForTab(tab: {
  fileSize?: number
  content?: string
}): EditorPerfProfile {
  if (tab.fileSize != null && Number.isFinite(tab.fileSize)) {
    return editorPerfProfile(tab.fileSize)
  }
  return editorPerfProfile(tab.content?.length ?? 0)
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
