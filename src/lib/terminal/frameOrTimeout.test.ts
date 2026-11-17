import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_FALLBACK_MS, runOnFrameOrTimeout } from './frameOrTimeout'

describe('runOnFrameOrTimeout', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map()
    nextFrame = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const flushFrames = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const cb of pending) cb(performance.now())
  }

  it('runs on the next frame and drops the timer (foreground)', () => {
    const callback = vi.fn()
    runOnFrameOrTimeout(callback)
    flushFrames()
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FRAME_FALLBACK_MS)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('runs from the timer when frames are paused (window in background)', () => {
    const callback = vi.fn()
    runOnFrameOrTimeout(callback)
    vi.advanceTimersByTime(FRAME_FALLBACK_MS - 1)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    flushFrames()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('runs neither once cancelled', () => {
    const callback = vi.fn()
    const cancel = runOnFrameOrTimeout(callback)
    cancel()
    flushFrames()
    vi.advanceTimersByTime(FRAME_FALLBACK_MS)
    expect(callback).not.toHaveBeenCalled()
  })
})
