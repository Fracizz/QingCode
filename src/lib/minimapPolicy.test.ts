import { describe, expect, it } from 'vitest'
import {
  MINIMAP_CHAR_HEIGHT,
  MINIMAP_FULL_MAX_BYTES,
  MINIMAP_HIDE_BYTES,
  MINIMAP_QUICK_VIEW_DELAY_MS,
  MINIMAP_WIDTH_DEFAULT,
  MINIMAP_WIDTH_MAX,
  MINIMAP_WIDTH_MIN,
  clampMinimapWidth,
  resolveMinimapByteSize,
  resolveMinimapCharSize,
  resolveMinimapContentHeight,
  resolveMinimapLineAtY,
  resolveMinimapLineSamples,
  resolveMinimapLineY,
  resolveMinimapMaxWidth,
  resolveMinimapMode,
  resolveMinimapScrollOffset,
  resolveMinimapScrollbarThumb,
  resolveMinimapViewport,
  resolveMinimapVisibleLines,
} from './minimapPolicy'
import { EDIT_DEGRADED_BYTES } from './fileSizePolicy'

describe('minimapPolicy', () => {
  it('aligns hide threshold with degraded edit band', () => {
    expect(MINIMAP_HIDE_BYTES).toBe(EDIT_DEGRADED_BYTES)
    expect(MINIMAP_HIDE_BYTES).toBe(5 * 1024 * 1024)
  })

  it('waits 1s before showing Quick View', () => {
    expect(MINIMAP_QUICK_VIEW_DELAY_MS).toBe(1000)
  })

  it('prefers fileSize over doc.length', () => {
    expect(resolveMinimapByteSize(2048, 99)).toBe(2048)
    expect(resolveMinimapByteSize(undefined, 99)).toBe(99)
    expect(resolveMinimapByteSize(null, 50)).toBe(50)
    expect(resolveMinimapByteSize(Number.NaN, 50)).toBe(50)
  })

  it('picks render mode by byte size', () => {
    expect(resolveMinimapMode(0)).toBe('full')
    expect(resolveMinimapMode(MINIMAP_FULL_MAX_BYTES)).toBe('full')
    expect(resolveMinimapMode(MINIMAP_FULL_MAX_BYTES + 1)).toBe('density')
    expect(resolveMinimapMode(MINIMAP_HIDE_BYTES)).toBe('density')
    expect(resolveMinimapMode(MINIMAP_HIDE_BYTES + 1)).toBe('hidden')
  })

  it('uses a readable fixed character scale', () => {
    expect(resolveMinimapCharSize('full')).toEqual({ charWidth: 3, charHeight: 4 })
    expect(resolveMinimapCharSize('density')).toEqual({ charWidth: 2, charHeight: 3 })
    expect(resolveMinimapContentHeight(100, MINIMAP_CHAR_HEIGHT)).toBe(400)
  })

  it('clamps width into the supported range', () => {
    expect(clampMinimapWidth(120)).toBe(120)
    expect(clampMinimapWidth(10)).toBe(MINIMAP_WIDTH_MIN)
    expect(clampMinimapWidth(999)).toBe(MINIMAP_WIDTH_MAX)
    expect(clampMinimapWidth(Number.NaN)).toBe(MINIMAP_WIDTH_DEFAULT)
  })

  it('leaves a safe editor width while resizing', () => {
    expect(resolveMinimapMaxWidth(900)).toBe(MINIMAP_WIDTH_MAX)
    expect(resolveMinimapMaxWidth(480)).toBe(120)
    expect(resolveMinimapMaxWidth(400)).toBe(MINIMAP_WIDTH_MIN)
    expect(clampMinimapWidth(220, resolveMinimapMaxWidth(480))).toBe(120)
  })

  it('keeps proportional sampling helper for short canvases', () => {
    expect(resolveMinimapLineSamples(3, 9)).toEqual([
      { lineNumber: 1, y: 0 },
      { lineNumber: 2, y: 4 },
      { lineNumber: 3, y: 8 },
    ])
  })

  it('windows visible lines at fixed scale instead of crushing them', () => {
    expect(resolveMinimapVisibleLines(1000, 12, 0, 4)).toEqual([
      { lineNumber: 1, y: 0 },
      { lineNumber: 2, y: 4 },
      { lineNumber: 3, y: 8 },
    ])
    expect(resolveMinimapVisibleLines(1000, 12, 400, 4)).toEqual([
      { lineNumber: 101, y: 0 },
      { lineNumber: 102, y: 4 },
      { lineNumber: 103, y: 8 },
    ])
  })

  it('scrolls scaled content with the editor', () => {
    expect(resolveMinimapScrollOffset(0, 1000, 100, 600, 200)).toBe(0)
    expect(resolveMinimapScrollOffset(900, 1000, 100, 600, 200)).toBe(400)
  })

  it('keeps the viewport inside the minimap at both scroll limits', () => {
    expect(resolveMinimapViewport(0, 1000, 100, 200)).toEqual({ top: 0, height: 20 })
    expect(resolveMinimapViewport(900, 1000, 100, 200)).toEqual({ top: 180, height: 20 })
    expect(resolveMinimapViewport(50, 100, 100, 200)).toEqual({ top: 0, height: 200 })
  })

  it('places a left scrollbar thumb from editor scroll metrics', () => {
    expect(resolveMinimapScrollbarThumb(0, 1000, 100, 200)).toEqual({ top: 0, height: 24 })
    expect(resolveMinimapScrollbarThumb(900, 1000, 100, 200)).toEqual({ top: 176, height: 24 })
    expect(resolveMinimapScrollbarThumb(0, 100, 100, 200)).toEqual({ top: 0, height: 200 })
  })

  it('maps line numbers to y and back for jump/caret', () => {
    expect(resolveMinimapLineY(1, 4, 0)).toBe(0)
    expect(resolveMinimapLineY(11, 4, 0)).toBe(40)
    expect(resolveMinimapLineY(11, 4, 16)).toBe(24)
    expect(resolveMinimapLineAtY(0, 4, 0, 100)).toBe(1)
    expect(resolveMinimapLineAtY(0, 4, 40, 100)).toBe(11)
  })
})
