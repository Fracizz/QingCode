import type { TermAttachResult, TermInfo } from '@qn/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountTerminalSession, type TerminalStatus } from './terminalSession'

const mocked = vi.hoisted(() => {
  class FakeTerminal {
    cols = 80
    rows = 24
    options = { disableStdin: true, fontSize: 13 }
    unicode = { activeVersion: '' }
    output: string[] = []
    onInput = (_data: string) => {}
    loadAddon() {}
    open() {}
    dispose() {}
    focus() {}
    onBinary() {}
    attachCustomKeyEventHandler() {}
    onData(listener: (data: string) => void) {
      this.onInput = listener
    }
    write(data: string | Uint8Array, callback?: () => void) {
      if (data.length) this.output.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      callback?.()
    }
    reset() {
      this.output = []
    }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }
  }

  const state = { current: null as FakeTerminal | null }
  return {
    Terminal: class extends FakeTerminal {
      constructor() {
        super()
        state.current = this
      }
    },
    state,
    request: vi.fn<(targetId: string, method: string, params: unknown) => Promise<unknown>>(),
    events: new Map<string, (targetId: string, payload: unknown) => void>(),
  }
})

vi.mock('@xterm/xterm', () => ({ Terminal: mocked.Terminal }))
vi.mock('../workspace/serverCall', () => ({
  serverCall: mocked.request,
  onServerEvt: (name: string, listener: (targetId: string, payload: unknown) => void) => {
    mocked.events.set(name, listener)
    return () => mocked.events.delete(name)
  },
}))

const info: TermInfo = {
  termId: 'pty-1', cwd: '/work', shell: '/bin/sh', args: [],
  pid: 1, backend: 'python', supportsResize: true, alive: true, lastSeq: 0,
  cols: 80, rows: 24, startedAt: 1,
}

function replay(lastSeq: number, entries: Array<[number, string]>): TermAttachResult {
  return {
    ...info, mode: 'replay', truncated: false, lastSeq,
    chunks: entries.map(([seq, data]) => ({ seq, data: btoa(data) })),
  }
}

const emitData = (seq: number, data: string, targetId = 'host') =>
  mocked.events.get('term.data')?.(targetId, { termId: info.termId, seq, data: btoa(data) })

describe('桌面终端连接', () => {
  beforeEach(() => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#151515' }))
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    mocked.request.mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    mocked.events.clear()
    vi.unstubAllGlobals()
  })

  it('断线时保留屏幕并停用输入，接回后合并回放和实时输出', async () => {
    let completeAttach: ((result: TermAttachResult) => void) | undefined
    mocked.request.mockResolvedValueOnce(replay(1, [[1, 'prompt']]))
      .mockImplementationOnce(() => new Promise((resolve) => { completeAttach = resolve }))
    let status: TerminalStatus | undefined
    const session = mountTerminalSession({} as HTMLElement, 'host', info, (value) => { status = value }, () => {})
    session.setReady(true)
    await Promise.resolve()
    const terminal = mocked.state.current!
    expect(terminal.output).toEqual(['prompt'])
    expect(status?.writable).toBe(true)
    session.setFontSize(18)
    expect(terminal.options.fontSize).toBe(18)
    expect(terminal.output).toEqual(['prompt'])

    emitData(2, 'other host', 'other')
    emitData(2, 'live')
    session.setReady(false)
    terminal.onInput('ignored')
    expect(terminal.output).toEqual(['prompt', 'live'])
    expect(status?.writable).toBe(false)

    session.setReady(true)
    expect(mocked.request.mock.calls).toEqual([
      ['host', 'term.attach', { termId: info.termId, sinceSeq: 0 }],
      ['host', 'term.attach', { termId: info.termId, sinceSeq: 2 }],
    ])
    emitData(3, 'duplicate')
    emitData(4, 'later')
    completeAttach?.(replay(3, [[3, 'replayed']]))
    await Promise.resolve()
    expect(terminal.output).toEqual(['prompt', 'live', 'replayed', 'later'])

    terminal.onInput('中')
    expect(mocked.request).toHaveBeenLastCalledWith(
      'host', 'term.write', { termId: info.termId, data: '5Lit' },
    )
    session.dispose()
    expect(mocked.request).toHaveBeenLastCalledWith('host', 'term.detach', { termId: info.termId })
  })

  it('回放截断时清屏并显示缺失状态，提前到达的退出事件优先于接回结果', async () => {
    let completeAttach: ((result: TermAttachResult) => void) | undefined
    mocked.request.mockResolvedValueOnce(replay(1, [[1, 'old']]))
      .mockImplementationOnce(() => new Promise((resolve) => { completeAttach = resolve }))
    let status: TerminalStatus | undefined
    const session = mountTerminalSession({} as HTMLElement, 'host', info, (value) => { status = value }, () => {})
    session.setReady(true)
    await Promise.resolve()
    session.setReady(false)
    session.setReady(true)
    mocked.events.get('term.exit')?.('host', { termId: info.termId, code: 7, signal: null })
    completeAttach?.({ ...replay(5, [[5, 'retained']]), mode: 'resync', truncated: true })
    await Promise.resolve()
    expect(mocked.state.current?.output).toEqual(['retained'])
    expect(status).toMatchObject({ historyLost: true, writable: false, exit: { code: 7, signal: null } })
    session.dispose()
  })
})
