import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceError, type WorkspaceContext } from '../workspace/registry'
import type { PtyBackendImpl, PtyExit, PtyProcess, PtySpawnOptions } from './backend'
import { MAX_WRITE_QUEUE_BYTES, termError, type OpenRequest } from './logic'
import { TerminalManager } from './manager'
import { setTerminalManagerForTest, terminalHandlers } from './index'
import type { TermDataEvt } from './types'

class FakePty implements PtyProcess {
  readonly backend: 'python' | 'script'
  readonly supportsResize: boolean
  readonly pid = 4242
  written: Buffer[] = []
  resizes: Array<[number, number]> = []
  killed = 0
  queued = 0
  private dataListener: ((chunk: Buffer) => void) | null = null
  private exitListener: ((exit: PtyExit) => void) | null = null

  constructor(
    readonly options: PtySpawnOptions,
    backend: 'python' | 'script' = 'python',
  ) {
    this.backend = backend
    this.supportsResize = backend === 'python'
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener
  }
  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListener = listener
  }
  write(data: Buffer): void {
    this.written.push(data)
  }
  pendingWriteBytes(): number {
    return this.queued
  }
  resize(cols: number, rows: number): boolean {
    if (!this.supportsResize) return false
    this.resizes.push([cols, rows])
    return true
  }
  kill(): void {
    this.killed++
  }
  emitData(text: string | Buffer): void {
    this.dataListener?.(typeof text === 'string' ? Buffer.from(text) : text)
  }
  emitExit(exit: PtyExit = { code: 0, signal: null }): void {
    this.exitListener?.(exit)
  }
}

interface Ctx {
  ctx: WorkspaceContext
  events: Array<{ name: string; payload: unknown }>
  close(): void
}

function makeCtx(clientId: number): Ctx {
  const events: Array<{ name: string; payload: unknown }> = []
  const cleanups: Array<() => void> = []
  let closed = false
  return {
    events,
    ctx: {
      clientId,
      emit(name, payload) {
        if (!closed) events.push({ name, payload })
      },
      onClose(cleanup) {
        cleanups.push(cleanup)
      },
      log() {},
    },
    close() {
      closed = true
      for (const c of cleanups.splice(0)) c()
    },
  }
}

function dataOf(c: Ctx, termId?: string): TermDataEvt[] {
  return c.events
    .filter((e) => e.name === 'term.data')
    .map((e) => e.payload as TermDataEvt)
    .filter((e) => termId === undefined || e.termId === termId)
}

function textOf(c: Ctx, termId?: string): string {
  return dataOf(c, termId)
    .map((e) => Buffer.from(e.data, 'base64').toString())
    .join('')
}

const req = (extra: Partial<OpenRequest> = {}): OpenRequest => ({
  cwd: '/work',
  args: [],
  cols: 80,
  rows: 24,
  env: {},
  backend: 'auto',
  ...extra,
})

let ptys: FakePty[]
let backendName: 'python' | 'script'
let ids: number

function makeManager(extra: ConstructorParameters<typeof TerminalManager>[0] = {}): TerminalManager {
  const backend = (): PtyBackendImpl => ({
    name: backendName,
    supportsResize: backendName === 'python',
    async spawn(options) {
      const pty = new FakePty(options, backendName)
      ptys.push(pty)
      return pty
    },
  })
  return new TerminalManager({
    resolveBackend: async () => backend(),
    env: { SHELL: '/bin/bash', PATH: '/usr/bin', QN_SECRET: 'x' },
    randomId: () => String(++ids),
    checkCwd: async () => {},
    flushDelayMs: 5,
    ...extra,
  })
}

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn()
  } catch (err) {
    return err instanceof WorkspaceError ? err.code : 'other'
  }
  return undefined
}

beforeEach(() => {
  vi.useFakeTimers()
  ptys = []
  backendName = 'python'
  ids = 0
})

afterEach(() => {
  vi.useRealTimers()
  setTerminalManagerForTest(null)
})

describe('TerminalManager', () => {
  it('open 生成 termId、用默认 shell 与过滤后的环境，并订阅发起连接', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const opened = await m.open(req(), a.ctx)
    expect(opened).toMatchObject({
      termId: 't-1',
      created: true,
      shell: '/bin/bash',
      backend: 'python',
      supportsResize: true,
      alive: true,
      lastSeq: 0,
      pid: 4242,
    })
    const pty = ptys[0]!
    expect(pty.options.env).toMatchObject({ PATH: '/usr/bin', TERM: 'xterm-256color', COLUMNS: '80', LINES: '24' })
    expect(pty.options.env.QN_SECRET).toBeUndefined()
    pty.emitData('hello')
    vi.advanceTimersByTime(5)
    expect(textOf(a)).toBe('hello')
    expect(m.activeCount).toBe(1)
  })

  it('小块输出合并节流，大输出按 32 KiB 切块且 seq 连续', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    const pty = ptys[0]!
    pty.emitData('a')
    pty.emitData('b')
    expect(dataOf(a)).toHaveLength(0)
    vi.advanceTimersByTime(5)
    expect(dataOf(a).map((e) => e.seq)).toEqual([1])
    pty.emitData(Buffer.alloc(70 * 1024, 0x78))
    expect(dataOf(a).map((e) => Buffer.from(e.data, 'base64').byteLength)).toEqual([2, 32768, 32768])
    vi.advanceTimersByTime(5)
    const all = dataOf(a, termId)
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(Buffer.from(all[3]!.data, 'base64').byteLength).toBe(70 * 1024 - 65536)
  })

  it('term.data 只发给订阅了该终端的连接；断开连接只取消订阅不关终端', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const b = makeCtx(2)
    const t1 = await m.open(req(), a.ctx)
    const t2 = await m.open(req(), b.ctx)
    ptys[0]!.emitData('one')
    ptys[1]!.emitData('two')
    vi.advanceTimersByTime(5)
    expect(textOf(a)).toBe('one')
    expect(textOf(b)).toBe('two')

    a.close()
    expect(ptys[0]!.killed).toBe(0)
    ptys[0]!.emitData('-more')
    vi.advanceTimersByTime(5)
    expect(textOf(a)).toBe('one')

    // 新连接接回：补发断开期间的输出
    const c = makeCtx(3)
    const attached = m.attach(t1.termId, 1, c.ctx)
    expect(attached).toMatchObject({ mode: 'replay', truncated: false, lastSeq: 2, alive: true })
    expect(attached.chunks.map((x) => Buffer.from(x.data, 'base64').toString())).toEqual(['-more'])
    ptys[0]!.emitData('!')
    vi.advanceTimersByTime(5)
    expect(textOf(c)).toBe('!')
    expect(textOf(b, t2.termId)).toBe('two')
  })

  it('attach 时合并器里尚未入缓冲的数据随后以 term.data 下发，不重不漏', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    ptys[0]!.emitData('x')
    vi.advanceTimersByTime(5)
    ptys[0]!.emitData('y')
    const b = makeCtx(2)
    const attached = m.attach(termId, 0, b.ctx)
    expect(attached.chunks.map((c) => c.seq)).toEqual([1])
    vi.advanceTimersByTime(5)
    expect(dataOf(b).map((e) => e.seq)).toEqual([2])
  })

  it('detach 只取消本连接订阅', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    m.detach(termId, a.ctx)
    ptys[0]!.emitData('z')
    vi.advanceTimersByTime(5)
    expect(dataOf(a)).toHaveLength(0)
    expect(m.list().terminals[0]).toMatchObject({ termId, alive: true, lastSeq: 1 })
  })

  it('同一 termId 再 open 视为接回；并发 open 只启动一个终端', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const b = makeCtx(2)
    const [first, second] = await Promise.all([
      m.open(req({ termId: 'tab-1' }), a.ctx),
      m.open(req({ termId: 'tab-1' }), b.ctx),
    ])
    expect(ptys).toHaveLength(1)
    expect(first.created).toBe(true)
    expect(second).toMatchObject({ termId: 'tab-1', created: false })
    ptys[0]!.emitData('both')
    vi.advanceTimersByTime(5)
    expect(textOf(a)).toBe('both')
    expect(textOf(b)).toBe('both')
  })

  it('write：转发字节、已退出报 term_exited、积压报 term_backpressure', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    const pty = ptys[0]!
    expect(m.write(termId, Buffer.from('ls\r'))).toEqual({ acceptedBytes: 3 })
    expect(m.write(termId, Buffer.alloc(0))).toEqual({ acceptedBytes: 0 })
    expect(pty.written.map((b) => b.toString())).toEqual(['ls\r'])
    pty.queued = MAX_WRITE_QUEUE_BYTES
    expect(await codeOf(() => m.write(termId, Buffer.from('x')))).toBe('term_backpressure')
    pty.queued = 0
    pty.emitExit({ code: 1, signal: null })
    expect(await codeOf(() => m.write(termId, Buffer.from('x')))).toBe('term_exited')
    expect(await codeOf(() => m.write('nope', Buffer.from('x')))).toBe('term_not_found')
  })

  it('resize：python 后端生效并广播 term.resized；script 后端 applied:false', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const b = makeCtx(2)
    const { termId } = await m.open(req(), a.ctx)
    m.attach(termId, 0, b.ctx)
    expect(m.resize(termId, 120, 40, a.ctx)).toEqual({ applied: true, cols: 120, rows: 40 })
    expect(ptys[0]!.resizes).toEqual([[120, 40]])
    expect(b.events.find((e) => e.name === 'term.resized')?.payload).toEqual({ termId, cols: 120, rows: 40, by: 1 })
    expect(m.list().terminals[0]).toMatchObject({ cols: 120, rows: 40 })

    backendName = 'script'
    const s = await m.open(req(), a.ctx)
    expect(s.supportsResize).toBe(false)
    expect(m.resize(s.termId, 100, 30, a.ctx)).toEqual({ applied: false, cols: 80, rows: 24 })
  })

  it('退出：先冲刷剩余输出再发 term.exit，保留缓冲供接回，保留期后清理', async () => {
    const m = makeManager({ retentionMs: 1000 })
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    ptys[0]!.emitData('bye')
    ptys[0]!.emitExit({ code: 7, signal: null })
    const names = a.events.map((e) => e.name)
    expect(names).toEqual(['term.data', 'term.exit'])
    expect(a.events[1]!.payload).toEqual({ termId, code: 7, signal: null })
    expect(m.activeCount).toBe(0)

    const b = makeCtx(2)
    const attached = m.attach(termId, 0, b.ctx)
    expect(attached).toMatchObject({ alive: false, exit: { code: 7, signal: null }, lastSeq: 1 })
    expect(attached.exitedAt).toBeTypeOf('number')
    const reopened = await m.open(req({ termId }), b.ctx)
    expect(reopened).toMatchObject({ created: false, alive: false })

    vi.advanceTimersByTime(1000)
    expect(m.list().terminals).toEqual([])
    expect(await codeOf(() => m.attach(termId, 0, b.ctx))).toBe('term_not_found')
  })

  it('close：运行中则 kill 并在退出后立即移除（订阅者收到 term.exit）；幂等', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    expect(m.close(termId)).toEqual({})
    expect(ptys[0]!.killed).toBe(1)
    expect(await codeOf(() => m.write(termId, Buffer.from('x')))).toBe('term_exited')
    ptys[0]!.emitExit({ code: null, signal: 'SIGHUP' })
    expect(a.events.at(-1)).toEqual({ name: 'term.exit', payload: { termId, code: null, signal: 'SIGHUP' } })
    expect(m.list().terminals).toEqual([])
    expect(m.close(termId)).toEqual({})
    expect(m.close('never-existed')).toEqual({})
  })

  it('快照：截断后接回给出快照 + 之后的增量；旧快照不覆盖新快照', async () => {
    const m = makeManager({ bufferBytes: 4 })
    const a = makeCtx(1)
    const { termId } = await m.open(req(), a.ctx)
    for (const s of ['11', '22', '33', '44']) {
      ptys[0]!.emitData(s)
      vi.advanceTimersByTime(5)
    }
    expect(m.snapshot(termId, { seq: 2, data: 'AA==', cols: 80, rows: 24 })).toEqual({ stored: true })
    expect(m.snapshot(termId, { seq: 1, data: 'AA==', cols: 80, rows: 24 })).toEqual({ stored: false })
    expect(await codeOf(() => m.snapshot(termId, { seq: 99, data: '', cols: 80, rows: 24 }))).toBe('params')
    const b = makeCtx(2)
    const attached = m.attach(termId, 0, b.ctx)
    expect(attached.mode).toBe('snapshot')
    expect(attached.snapshot?.seq).toBe(2)
    expect(attached.chunks.map((c) => c.seq)).toEqual([3, 4])
  })

  it('终端数上限、启动失败不占位、cwd 校验错误原样返回', async () => {
    const m = makeManager({ maxTerminals: 1 })
    const a = makeCtx(1)
    await m.open(req(), a.ctx)
    expect(await codeOf(() => m.open(req(), a.ctx))).toBe('term_limit')

    const failing = makeManager({
      resolveBackend: async () => {
        throw termError('pty_unavailable', '没有后端')
      },
    })
    expect(await codeOf(() => failing.open(req({ termId: 'x' }), a.ctx))).toBe('pty_unavailable')
    expect(failing.activeCount).toBe(0)
    expect(failing.list().terminals).toEqual([])

    const badCwd = makeManager({
      checkCwd: async () => {
        throw termError('not_found', 'cwd 不存在')
      },
    })
    expect(await codeOf(() => badCwd.open(req(), a.ctx))).toBe('not_found')
  })

  it('shutdown 结束全部终端并拒绝新的 open', async () => {
    const m = makeManager()
    const a = makeCtx(1)
    await m.open(req(), a.ctx)
    await m.open(req(), a.ctx)
    m.shutdown()
    expect(ptys.map((p) => p.killed)).toEqual([1, 1])
    expect(m.list().terminals).toEqual([])
    expect(await codeOf(() => m.open(req(), a.ctx))).toBe('term_spawn_failed')
  })
})

describe('terminalHandlers', () => {
  it('经处理函数走完整流程（参数解析 + 单例管理器）', async () => {
    setTerminalManagerForTest(makeManager())
    const a = makeCtx(1)
    const open = terminalHandlers['term.open']!
    // handler 按本机平台校验绝对路径
    const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'
    const opened = (await open({ cwd, cols: 100, rows: 30, shell: '/bin/zsh' }, a.ctx)) as { termId: string }
    expect(ptys[0]!.options).toMatchObject({ shell: '/bin/zsh', cols: 100, rows: 30, cwd })
    const data = Buffer.from('echo hi\r').toString('base64')
    expect(await terminalHandlers['term.write']!({ termId: opened.termId, data }, a.ctx)).toEqual({ acceptedBytes: 8 })
    expect(await terminalHandlers['term.resize']!({ termId: opened.termId, cols: 90, rows: 20 }, a.ctx)).toMatchObject({ applied: true })
    expect(await terminalHandlers['term.list']!({}, a.ctx)).toMatchObject({ terminals: [{ termId: opened.termId, cols: 90 }] })
    expect(await terminalHandlers['term.attach']!({ termId: opened.termId, sinceSeq: 0 }, a.ctx)).toMatchObject({ mode: 'replay' })
    expect(await terminalHandlers['term.snapshot']!({ termId: opened.termId, seq: 0, data: '' }, a.ctx)).toEqual({ stored: true })
    expect(await terminalHandlers['term.detach']!({ termId: opened.termId }, a.ctx)).toEqual({})
    expect(await terminalHandlers['term.close']!({ termId: opened.termId }, a.ctx)).toEqual({})
    expect(await codeOf(() => open({ cwd: 'rel' }, a.ctx))).toBe('params')
    expect(await codeOf(() => terminalHandlers['term.write']!({ termId: 'x', data: 1 }, a.ctx))).toBe('params')
  })
})
