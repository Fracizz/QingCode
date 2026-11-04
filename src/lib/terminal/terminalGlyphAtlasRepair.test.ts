import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLYPH_ATLAS_REPAIR_DELAY_MS, createGlyphAtlasRepairScheduler } from './terminalGlyphAtlasRepair'

describe('glyph atlas repair scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst of page removals from one merge into a single repair', () => {
    const repair = vi.fn()
    const scheduler = createGlyphAtlasRepairScheduler(repair, GLYPH_ATLAS_REPAIR_DELAY_MS, globalThis)
    // 一次合并会移除 4 页。
    for (let index = 0; index < 4; index++) scheduler.schedule()
    expect(repair).not.toHaveBeenCalled()
    vi.advanceTimersByTime(GLYPH_ATLAS_REPAIR_DELAY_MS)
    expect(repair).toHaveBeenCalledTimes(1)

    // 之后的合并会再次触发修复。
    scheduler.schedule()
    vi.advanceTimersByTime(GLYPH_ATLAS_REPAIR_DELAY_MS)
    expect(repair).toHaveBeenCalledTimes(2)
  })

  it('repairs immediately on manual request and drops the pending one', () => {
    const repair = vi.fn()
    const scheduler = createGlyphAtlasRepairScheduler(repair, GLYPH_ATLAS_REPAIR_DELAY_MS, globalThis)
    scheduler.schedule()
    scheduler.repairNow()
    expect(repair).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GLYPH_ATLAS_REPAIR_DELAY_MS * 2)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('never repairs after dispose and swallows renderer errors', () => {
    const failing = vi.fn(() => {
      throw new Error('context lost')
    })
    const scheduler = createGlyphAtlasRepairScheduler(failing, GLYPH_ATLAS_REPAIR_DELAY_MS, globalThis)
    expect(() => scheduler.repairNow()).not.toThrow()
    scheduler.schedule()
    scheduler.dispose()
    vi.advanceTimersByTime(GLYPH_ATLAS_REPAIR_DELAY_MS * 2)
    expect(failing).toHaveBeenCalledTimes(1)
    scheduler.schedule()
    scheduler.repairNow()
    expect(failing).toHaveBeenCalledTimes(1)
  })
})
