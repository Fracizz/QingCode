import { describe, expect, it } from 'vitest'
import {
  PiRpcProcess,
  classifyRecord,
  splitJsonl,
  type PiProcessLike,
  type PiRpcSpawnSpec,
} from './rpc'

describe('JSONL 分帧（严格 LF）', () => {
  it('按 LF 切分、去掉 CR、保留末尾未换行的一段', () => {
    const result = splitJsonl('{"a":1}\r\n\n{"b":2}\n{"c":3')
    expect(result.records).toEqual([{ a: 1 }, { b: 2 }])
    expect(result.remainder).toBe('{"c":3')
    expect(result.invalid).toBe(0)
  })

  it('U+2028/U+2029 是 JSON 字符串内容，不能当记录边界', () => {
    const line = JSON.stringify({ text: '第一行\u2028第二行\u2029结束' })
    const first = splitJsonl(`${line.slice(0, 12)}`)
    expect(first.records).toHaveLength(0)
    expect(first.remainder).toBe(line.slice(0, 12))
    const second = splitJsonl(`${first.remainder}${line.slice(12)}\n`)
    expect(second.records[0]).toEqual({ text: '第一行\u2028第二行\u2029结束' })
    expect(second.remainder).toBe('')
  })

  it('非 JSON 行与非对象 JSON 只计数，不影响其它记录', () => {
    const result = splitJsonl('oops\n[1,2]\n{"ok":true}\n')
    expect(result.records).toEqual([{ ok: true }])
    expect(result.invalid).toBe(2)
  })
})

describe('记录分类', () => {
  it('响应 / 扩展 UI / 会话事件分流', () => {
    expect(classifyRecord({ type: 'response', id: 'x', success: true })).toBe('response')
    expect(classifyRecord({ type: 'extension_ui_request', id: 'y' })).toBe('extension_ui')
    expect(classifyRecord({ type: 'extension_ui_response', id: 'y' })).toBe('extension_ui')
    expect(classifyRecord({ type: 'message_update' })).toBe('event')
    expect(classifyRecord(null)).toBe('event')
  })
})

class FakeProcess {
  readonly written: string[] = []
  ended = false
  killed = false
  pid = 4242
  private stdoutCb: ((chunk: Buffer | string) => void) | null = null
  private errorCb: ((err: Error) => void) | null = null
  private exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null

  readonly stdin = {
    write: (chunk: string) => {
      this.written.push(chunk)
      return true
    },
    end: () => {
      this.ended = true
    },
  }
  readonly stdout = {
    on: (_event: 'data', cb: (chunk: Buffer | string) => void) => {
      this.stdoutCb = cb
    },
  }
  readonly stderr = {
    on: (_event: 'data', _cb: (chunk: Buffer | string) => void) => {},
  }

  on(
    event: 'error' | 'exit',
    cb: ((err: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): void {
    if (event === 'error') this.errorCb = cb as (err: Error) => void
    else this.exitCb = cb as (code: number | null, signal: NodeJS.Signals | null) => void
  }

  kill(): void {
    this.killed = true
  }

  emitStdout(text: string): void {
    this.stdoutCb?.(Buffer.from(text))
  }

  emitExit(code: number | null = 0): void {
    this.exitCb?.(code, null)
  }

  emitError(err: Error): void {
    this.errorCb?.(err)
  }

  asProcess(): PiProcessLike {
    return this as unknown as PiProcessLike
  }
}

function makeHarness() {
  const child = new FakeProcess()
  const specs: PiRpcSpawnSpec[] = []
  const logs: string[] = []
  const rpc = new PiRpcProcess({
    command: { command: '/opt/pi', args: [], shell: false },
    cwd: '/work',
    log: (message) => logs.push(message),
    extraArgs: ['--no-session'],
    spawnProcess: (spec) => {
      specs.push(spec)
      return child.asProcess()
    },
    commandTimeoutMs: 50,
  })
  return { rpc, child, specs, logs }
}

describe('PiRpcProcess', () => {
  it('spawn 只加 --mode rpc 与会话参数，原样继承环境', () => {
    const { rpc, specs } = makeHarness()
    rpc.start()
    const spec = specs[0]
    expect(spec?.command).toBe('/opt/pi')
    expect(spec?.args).toEqual(['--mode', 'rpc', '--no-session'])
    expect(spec?.cwd).toBe('/work')
    expect(spec?.shell).toBe(false)
    expect(spec?.env.PATH).toBe(process.env.PATH)
    rpc.close()
  })

  it('命令响应按 id 关联，会话事件分流，扩展 UI 不代答', async () => {
    const { rpc, child } = makeHarness()
    rpc.start()
    const events: Record<string, unknown>[] = []
    rpc.onEvent((record) => events.push(record))
    const promise = rpc.command('get_state')
    const sent = JSON.parse(child.written[0] ?? '{}') as { id: string; type: string }
    expect(sent.type).toBe('get_state')
    child.emitStdout(
      `${JSON.stringify({ type: 'turn_start' })}\n` +
        `${JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm' })}\n` +
        `${JSON.stringify({ type: 'response', id: 'other', command: 'get_state', success: true })}\n` +
        `${JSON.stringify({ type: 'response', id: sent.id, command: 'get_state', success: true, data: { sessionId: 's1' } })}\n`,
    )
    const response = await promise
    expect(response.data).toEqual({ sessionId: 's1' })
    expect(events).toEqual([{ type: 'turn_start' }])
    rpc.close()
  })

  it('进程退出拒绝未完成命令并通知监听者；close 先关 stdin', async () => {
    const { rpc, child, logs } = makeHarness()
    rpc.start()
    const exits: number[] = []
    rpc.onExit((info) => exits.push(info.code ?? -1))
    const pending = rpc.command('prompt', { message: 'x' })
    child.emitExit(3)
    await expect(pending).rejects.toThrow(/退出/)
    expect(exits).toEqual([3])
    expect(rpc.running).toBe(false)
    expect(logs.join('\n')).not.toContain('message')
    rpc.close()
    expect(child.ended).toBe(true)
  })

  it('stdout 出现非 JSON 行只记日志，不解析 stderr 为协议数据', () => {
    const { rpc, child, logs } = makeHarness()
    rpc.start()
    child.emitStdout('not-json\n')
    expect(logs.some((line) => line.includes('非 JSON'))).toBe(true)
    rpc.close()
  })
})
