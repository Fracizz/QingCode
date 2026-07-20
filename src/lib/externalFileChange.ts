import type { EditorPerfProfile } from './fileSizePolicy'

export type ExternalChangeBeforeRead = 'ignore' | 'notify-view' | 'read'
export type ExternalChangeAfterRead = 'update-mtime' | 'reload' | 'prompt'

export function decideExternalChangeBeforeRead(input: {
  viewMode?: 'edit' | 'view'
  profile: EditorPerfProfile
  diskMtime?: number | null
  nextMtime: number | null
}): ExternalChangeBeforeRead {
  const unchanged =
    input.nextMtime != null &&
    input.diskMtime != null &&
    input.nextMtime === input.diskMtime

  if (input.viewMode === 'view') return unchanged ? 'ignore' : 'notify-view'
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
