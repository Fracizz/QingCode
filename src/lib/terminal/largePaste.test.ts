import { describe, expect, it } from 'vitest'
import {
  formatPasteSize,
  LARGE_PASTE_MAX_CHARS,
  LARGE_PASTE_MAX_LINES,
  largePasteFileName,
  largePasteStats,
} from './largePaste'

describe('largePasteStats', () => {
  it('ignores ordinary pastes', () => {
    expect(largePasteStats('git status')).toBeNull()
    expect(largePasteStats('a\n'.repeat(LARGE_PASTE_MAX_LINES))).toBeNull()
    expect(largePasteStats('x'.repeat(LARGE_PASTE_MAX_CHARS))).toBeNull()
  })

  it('flags text over the character limit', () => {
    expect(largePasteStats('x'.repeat(LARGE_PASTE_MAX_CHARS + 1))).toEqual({
      chars: LARGE_PASTE_MAX_CHARS + 1,
      lines: 1,
    })
  })

  it('counts CRLF, LF and lone CR line breaks once each', () => {
    const text = 'a\r\n'.repeat(300) + 'b\n'.repeat(150) + 'c\r'.repeat(100)
    expect(largePasteStats(text)?.lines).toBe(550)
  })
})

describe('largePasteFileName', () => {
  it('uses a sortable local timestamp', () => {
    expect(largePasteFileName(new Date(2026, 10, 5, 2, 15, 30))).toBe('pasted-text-20261105-021530.txt')
  })
})

describe('formatPasteSize', () => {
  it('formats KB and MB', () => {
    expect(formatPasteSize(163856)).toBe('160 KB')
    expect(formatPasteSize(100)).toBe('1 KB')
    expect(formatPasteSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })
})
