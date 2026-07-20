import { describe, expect, it } from 'vitest'
import {
  decideExternalChangeAfterRead,
  decideExternalChangeBeforeRead,
} from './externalFileChange'

describe('external file change decisions', () => {
  it('does not read unchanged large files or unchanged read-only previews', () => {
    expect(
      decideExternalChangeBeforeRead({
        viewMode: 'edit',
        profile: 'plain',
        diskMtime: 12,
        nextMtime: 12,
      }),
    ).toBe('ignore')
    expect(
      decideExternalChangeBeforeRead({
        viewMode: 'view',
        profile: 'plain',
        diskMtime: 12,
        nextMtime: 12,
      }),
    ).toBe('ignore')
  })

  it('updates read-only metadata without pulling the full file into memory', () => {
    expect(
      decideExternalChangeBeforeRead({
        viewMode: 'view',
        profile: 'plain',
        diskMtime: 12,
        nextMtime: 13,
      }),
    ).toBe('notify-view')
  })

  it('reloads clean external edits and prompts before replacing dirty content', () => {
    expect(
      decideExternalChangeAfterRead({
        dirty: false,
        localContent: 'before',
        diskContent: 'after',
      }),
    ).toBe('reload')
    expect(
      decideExternalChangeAfterRead({
        dirty: true,
        localContent: 'local draft',
        diskContent: 'external edit',
      }),
    ).toBe('prompt')
  })

  it('only advances the mtime when clean content is already identical', () => {
    expect(
      decideExternalChangeAfterRead({
        dirty: false,
        localContent: 'same',
        diskContent: 'same',
      }),
    ).toBe('update-mtime')
  })
})
