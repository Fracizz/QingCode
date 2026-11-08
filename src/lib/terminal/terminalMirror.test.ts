import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/lib/tauri', () => ({ safeInvoke: invoke }))

import {
  beginTerminalMirror,
  bytesToBase64,
  finishTerminalMirror,
  forwardTerminalMirrorOutput,
  forwardTerminalMirrorScreen,
  isTerminalMirrored,
  stopTerminalMirror,
  takeMirrorBatch,
} from './terminalMirror'

const bytes = (...values: number[]) => new Uint8Array(values)
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const commands = () => (invoke.mock.calls as unknown[][]).map(call => call[1])

describe('terminal mirror forwarding', () => {
  beforeEach(() => {
    invoke.mockClear()
    stopTerminalMirror('t')
  })

  it('holds output collected during capture until the seed has been delivered', async () => {
    const open = beginTerminalMirror('t')
    forwardTerminalMirrorOutput('t', bytes(104, 105))
    await settle()
    expect(invoke).not.toHaveBeenCalled()
    open()
    await settle()
    expect(invoke).toHaveBeenCalledWith('转发终端输出', 'mobile_mirror_output', { id: 't', data: 'aGk=' })
  })

  it('sends output, screens and exit in arrival order', async () => {
    const open = beginTerminalMirror('t')
    forwardTerminalMirrorOutput('t', bytes(1))
    forwardTerminalMirrorScreen('t', { data: 'S', cols: 80, rows: 24 })
    forwardTerminalMirrorOutput('t', bytes(2))
    finishTerminalMirror('t', 3, false)
    open()
    await settle()
    expect(commands()).toEqual([
      'mobile_mirror_output', 'mobile_mirror_screen', 'mobile_mirror_output', 'mobile_mirror_finish',
    ])
    expect(isTerminalMirrored('t')).toBe(false)
  })

  it('merges adjacent output into one call but keeps each call bounded', () => {
    const queue = [
      { kind: 'bytes' as const, bytes: bytes(1, 2) },
      { kind: 'bytes' as const, bytes: bytes(3) },
      { kind: 'screen' as const, data: 'S', cols: 80, rows: 24 },
    ]
    expect(takeMirrorBatch(queue)).toEqual({ kind: 'bytes', bytes: bytes(1, 2, 3) })
    expect(queue).toHaveLength(1)

    const large = new Uint8Array(40 * 1024)
    const bounded = [{ kind: 'bytes' as const, bytes: large }, { kind: 'bytes' as const, bytes: large }]
    takeMirrorBatch(bounded)
    expect(bounded).toHaveLength(1)
  })

  it('drops queued output once the phone no longer holds the terminal', async () => {
    const open = beginTerminalMirror('t')
    forwardTerminalMirrorOutput('t', bytes(1))
    stopTerminalMirror('t')
    open()
    forwardTerminalMirrorOutput('t', bytes(2))
    await settle()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps forwarding after a failed send', async () => {
    invoke.mockImplementationOnce(() => Promise.reject(new Error('busy')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const open = beginTerminalMirror('t')
    forwardTerminalMirrorOutput('t', bytes(1))
    forwardTerminalMirrorScreen('t', { data: 'S', cols: 80, rows: 24 })
    open()
    await settle()
    expect(commands()).toEqual(['mobile_mirror_output', 'mobile_mirror_screen'])
    warn.mockRestore()
  })

  it('encodes large buffers without exhausting the call stack', () => {
    expect(bytesToBase64(new Uint8Array(200_000)).length).toBe(266_668)
  })
})
