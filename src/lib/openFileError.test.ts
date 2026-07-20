import { describe, expect, it } from 'vitest'
import { isLoadingTab, tabNeedsDiskContent } from './openFileError'

describe('isLoadingTab', () => {
  it('treats progressive open (no content yet) as loading', () => {
    expect(isLoadingTab({ loading: true })).toBe(true)
    expect(isLoadingTab({ content: undefined })).toBe(true)
  })

  it('does not treat plain-profile buffer clear as loading', () => {
    // After bind, plain tabs drop the Zustand duplicate but keep disk metadata.
    expect(
      isLoadingTab({
        content: undefined,
        fileSize: 30 * 1024 * 1024,
        diskMtime: 1,
      }),
    ).toBe(false)
  })

  it('keeps view-mode tabs loading only while the flag is set', () => {
    expect(isLoadingTab({ viewMode: 'view', loading: true })).toBe(true)
    expect(isLoadingTab({ viewMode: 'view', loading: false, fileSize: 1 })).toBe(false)
  })
})

describe('tabNeedsDiskContent', () => {
  it('requests load for session-restored edit tabs', () => {
    expect(tabNeedsDiskContent({ content: undefined })).toBe(true)
  })

  it('skips plain tabs that already opened (content cleared on purpose)', () => {
    expect(
      tabNeedsDiskContent({
        content: undefined,
        fileSize: 30 * 1024 * 1024,
        diskMtime: 1,
      }),
    ).toBe(false)
  })

  it('still refreshes mtime when draft content exists without diskMtime', () => {
    expect(tabNeedsDiskContent({ content: 'draft', diskMtime: undefined })).toBe(true)
  })
})
