import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireTerminalWebglSlot,
  releaseTerminalWebglSlot,
  resetTerminalWebglSlotsForTest,
  terminalWebglSlotCount,
  touchTerminalWebglSlot,
} from '@/lib/terminal/terminalWebglBudget'

describe('terminal WebGL budget', () => {
  beforeEach(() => resetTerminalWebglSlotsForTest())

  it('grants slots within the budget and refreshes existing holders', () => {
    const release = vi.fn()
    expect(acquireTerminalWebglSlot('a', () => true, release, 2)).toBe(true)
    expect(acquireTerminalWebglSlot('a', () => true, release, 2)).toBe(true)
    expect(terminalWebglSlotCount()).toBe(1)
    expect(release).not.toHaveBeenCalled()
  })

  it('evicts the least recently used hidden terminal when the budget is full', () => {
    const releaseA = vi.fn()
    const releaseB = vi.fn()
    acquireTerminalWebglSlot('a', () => false, releaseA, 2)
    acquireTerminalWebglSlot('b', () => false, releaseB, 2)
    touchTerminalWebglSlot('a')

    expect(acquireTerminalWebglSlot('c', () => true, vi.fn(), 2)).toBe(true)
    expect(releaseB).toHaveBeenCalledTimes(1)
    expect(releaseA).not.toHaveBeenCalled()
    expect(terminalWebglSlotCount()).toBe(2)
  })

  it('never evicts visible terminals', () => {
    const release = vi.fn()
    acquireTerminalWebglSlot('a', () => true, release, 1)
    expect(acquireTerminalWebglSlot('b', () => true, vi.fn(), 1)).toBe(false)
    expect(release).not.toHaveBeenCalled()
  })

  it('frees the slot without calling release when a holder unmounts', () => {
    const release = vi.fn()
    acquireTerminalWebglSlot('a', () => false, release, 1)
    releaseTerminalWebglSlot('a')
    expect(acquireTerminalWebglSlot('b', () => true, vi.fn(), 1)).toBe(true)
    expect(release).not.toHaveBeenCalled()
  })
})
