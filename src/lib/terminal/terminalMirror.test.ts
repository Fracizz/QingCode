import { describe, expect, it } from 'vitest'
import { registerTerminalCapture, terminalCapture } from './terminalMirror'

describe('terminal capture registry', () => {
  it('returns the latest capture and ignores stale unregistration', async () => {
    const first = () => Promise.resolve({ data: 'a', cols: 80, rows: 24 })
    const second = () => Promise.resolve({ data: 'b', cols: 100, rows: 30 })
    const unregisterFirst = registerTerminalCapture('t', first)
    const unregisterSecond = registerTerminalCapture('t', second)
    unregisterFirst()
    expect(terminalCapture('t')).toBe(second)
    await expect(terminalCapture('t')?.()).resolves.toEqual({ data: 'b', cols: 100, rows: 30 })
    unregisterSecond()
    expect(terminalCapture('t')).toBeUndefined()
  })
})
