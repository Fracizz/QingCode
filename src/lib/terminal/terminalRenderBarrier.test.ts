import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_RENDER_BARRIER_TIMEOUT_MS, waitForTerminalRender } from '@/lib/terminal/terminalRenderBarrier'

describe('terminal render barrier', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for xterm onRender instead of assuming the next frame is ready', async () => {
    let onRender: (() => void) | undefined
    const dispose = vi.fn()
    const terminal = {
      onRender: (listener: () => void) => {
        onRender = listener
        return { dispose }
      },
    }

    const ready = waitForTerminalRender(terminal, () => true)
    let completed = false
    void ready.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    onRender?.()
    await expect(ready).resolves.toBe('rendered')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not hold the old frame when the character grid did not change', async () => {
    const dispose = vi.fn()
    const terminal = {
      onRender: () => ({ dispose }),
    }

    await expect(waitForTerminalRender(terminal, () => false)).resolves.toBe('unchanged')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('releases a hidden or disposed terminal through the safety timeout', async () => {
    vi.useFakeTimers()
    const dispose = vi.fn()
    const terminal = {
      onRender: () => ({ dispose }),
    }

    const ready = waitForTerminalRender(terminal, () => true)
    await vi.advanceTimersByTimeAsync(TERMINAL_RENDER_BARRIER_TIMEOUT_MS)

    await expect(ready).resolves.toBe('timeout')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
