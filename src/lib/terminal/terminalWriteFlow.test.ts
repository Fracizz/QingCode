import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_WRITE_HIGH_WATERMARK,
  TERMINAL_WRITE_LOW_WATERMARK,
  TerminalWriteFlow,
} from './terminalWriteFlow'

describe('TerminalWriteFlow', () => {
  it('pauses at the high watermark and resumes at the low watermark once', () => {
    const onPauseChange = vi.fn()
    const flow = new TerminalWriteFlow(onPauseChange)
    flow.written(TERMINAL_WRITE_HIGH_WATERMARK - 1)
    expect(onPauseChange).not.toHaveBeenCalled()
    flow.written(1)
    flow.written(1024)
    expect(onPauseChange.mock.calls).toEqual([[true]])

    flow.parsed(TERMINAL_WRITE_HIGH_WATERMARK - TERMINAL_WRITE_LOW_WATERMARK)
    expect(onPauseChange.mock.calls).toEqual([[true]])
    flow.parsed(1024)
    expect(onPauseChange.mock.calls).toEqual([[true], [false]])
  })

  it('releases a held pause on dispose only', () => {
    const onPauseChange = vi.fn()
    const flow = new TerminalWriteFlow(onPauseChange)
    flow.dispose()
    expect(onPauseChange).not.toHaveBeenCalled()
    flow.written(TERMINAL_WRITE_HIGH_WATERMARK)
    flow.dispose()
    expect(onPauseChange.mock.calls).toEqual([[true], [false]])
  })
})
