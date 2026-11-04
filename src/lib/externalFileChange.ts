import { isNonEditableViewMode, type EditorViewMode } from './openFileError'
import type { EditorPerfProfile } from './fileSizePolicy'

export type ExternalChangeBeforeRead = 'ignore' | 'notify-view' | 'read'
export type ExternalChangeAfterRead = 'update-mtime' | 'reload' | 'prompt'

export function decideExternalChangeBeforeRead(input: {
  viewMode?: EditorViewMode
  profile: EditorPerfProfile
  diskMtime?: number | null
  nextMtime: number | null
}): ExternalChangeBeforeRead {
  const unchanged =
    input.nextMtime != null &&
    input.diskMtime != null &&
    input.nextMtime === input.diskMtime

  // View / image tabs never hold decoded text: just bump mtime metadata so the
  // viewer (slice or image) refetches on its own.
  if (isNonEditableViewMode(input)) return unchanged ? 'ignore' : 'notify-view'
  if ((input.profile === 'plain' || input.profile === 'degraded') && unchanged) {
    return 'ignore'
  }
  return 'read'
}

export function decideExternalChangeAfterRead(input: {
  dirty: boolean
  localContent: string
  diskContent: string
}): ExternalChangeAfterRead {
  if (input.dirty) return 'prompt'
  return input.localContent === input.diskContent ? 'update-mtime' : 'reload'
}
