/**
 * daemon 层端到端：注入假 query 工厂，验证两个 agent 的 req 路由、seq/回放隔离、
 * codex.recv 的 agent 标签、status 与非法 agent 的处理。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, encodeFrame, FrameDecoder } from '@qn/protocol'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readToken, resolvePaths } from '../paths'

type Frame = Record<string, unknown>
type Predicate = (frame: Frame) => boolean

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(srcDir, '..')
const fakeCodex = path.resolve(srcDir, '../../test/fake-codex.mjs')

/** 自定义 daemon 入口：假 query 工厂，避免拉起真实 claude。 */
const TEST_ENTRY = `
import { runDaemon } from './daemon'
import { createClaudeHost } from './claude/bridge'

class FakeQuery {
  async *[Symbol.asyncIterator]() {
    yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } }
    yield { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '你好' }] } }
    yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, result: '你好' }
  }
  async interrupt() {}
  close() {}
}

const deps = {
  query: () => new FakeQuery(),
  listSessions: async () => [],
  getSessionMessages: async () => [],
}
const args = process.argv.slice(2)
const at = args.indexOf('--state-dir')
const stateDir = at >= 0 ? args[at + 1] : undefined
runDaemon({
  stateDir,
  version: '0.0.1',
  createClaudeHost: (hub, version) =>
    createClaudeHost(hub, version, {
      deps,
      resolve: () => ({ path: 'C:/fake/claude.exe', version: '2.1.331' }),
    }),
}).catch((err) => {
  process.stderr.write(String(err) + '\\n')
  process.exit(1)
})
`

class Client {
  readonly socket: net.Socket
  readonly all: Frame[] = []
  private readonly decoder = new FrameDecoder()
  private reqId = 0
  private stderr = ''

  constructor(endpoint: string) {
    this.socket = net.createConnection({ path: endpoint })
    this.socket.on('data', (chunk: Buffer) => {
      let frames: unknown[]
      try {
        frames = this.decoder.push(chunk)
      } catch {
        return
      }
      for (const frame of frames) if (isRecord(frame)) this.all.push(frame)
    })
    this.socket.on('error', () => {})
  }

  send(msg: unknown): void {
    this.socket.write(Buffer.from(encodeFrame(msg)))
  }

  async hello(token: string): Promise<Frame> {
    this.send({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      token,
      client: { name: 'claude-e2e', version: '0.0.1' },
    })
    return this.wait((f) => f.t === 'welcome' || f.t === 'error')
  }

  async req(method: string, params?: unknown): Promise<Frame> {
    const id = ++this.reqId
    this.send({ t: 'req', id, method, ...(params !== undefined ? { params } : {}) })
    const res = await this.wait((f) => f.t === 'res' && f.id === id)
    if (res.ok !== true) {
      throw new Error(`${method} 失败: ${String((res.error as Frame)?.message ?? 'unknown')}`)
    }
    return (res.result ?? null) as Frame
  }

  wait(pred: Predicate, timeoutMs = 8000): Promise<Frame> {
    const existing = this.all.find(pred)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poller)
        reject(new Error(`等待帧超时；已有 ${JSON.stringify(this.all.slice(-12))}; stderr=${this.stderr}`))
      }, timeoutMs)
      const poller = setInterval(() => {
        const found = this.all.find(pred)
        if (found) {
          clearInterval(poller)
          clearTimeout(timer)
          resolve(found)
        }
      }, 10)
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

function isRecord(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let root = ''
let stateDir = ''
let bundle = ''
let daemon: ChildProcess | null = null
let token = ''
let endpoint = ''
let codexPath = ''
let daemonStderr = ''

describe('daemon 的 agent 分发与协议扩展', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-claude-e2e-'))
    stateDir = path.join(root, 'state')
    bundle = path.join(root, 'daemon-test.cjs')
    fs.mkdirSync(stateDir, { recursive: true })
    await build({
      stdin: {
        contents: TEST_ENTRY,
        resolveDir: serverDir,
        loader: 'ts',
        sourcefile: 'daemon-claude-test.ts',
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      define: { 'import.meta.url': '__qn_import_meta_url' },
      banner: {
        js: "const __qn_import_meta_url = require('node:url').pathToFileURL(__filename).href;",
      },
      logLevel: 'silent',
    })
    const paths = resolvePaths(stateDir)
    endpoint = paths.endpoint
    codexPath = JSON.stringify([process.execPath, fakeCodex, path.join(root, 'codex.log')])
    daemon = spawn(process.execPath, [bundle, 'daemon', '--state-dir', stateDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    daemon.stderr?.on('data', (chunk: Buffer) => {
      daemonStderr += chunk.toString('utf8')
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const found = readToken(paths)
      if (found) {
        token = found
        break
      }
      await sleep(50)
    }
    if (!token) throw new Error(`daemon 未就绪: ${daemonStderr}`)
  }, 60_000)

  afterAll(async () => {
    const client = new Client(endpoint)
    const welcome = await client.hello(token).catch(() => null)
    if (welcome?.t === 'welcome') await client.req('server.shutdown').catch(() => null)
    client.close()
    await sleep(200)
    if (daemon && !daemon.killed) daemon.kill()
    await sleep(100)
    fs.rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('hello / 两个 agent 各自 open+attach，status 互不干扰', async () => {
    const client = new Client(endpoint)
    expect((await client.hello(token)).t).toBe('welcome')
    expect(await client.req('ping')).toMatchObject({ protocol: PROTOCOL_VERSION })

    const codex = await client.req('codex.open', { agent: 'codex', codexPath })
    expect(codex.codexVersion).toBe('0.172.0')
    expect(codex.agentVersion).toBe('0.172.0')
    expect(codex.initialize).toMatchObject({ userAgent: 'fake-codex/0.172.0' })
    expect(await client.req('codex.attach', { sinceSeq: 0 })).toMatchObject({ truncated: false, accessModes: true })

    const claude = await client.req('codex.open', { agent: 'claude' })
    expect(claude.lastSeq).toBe(0)
    expect(claude.agentVersion).toBe('2.1.331')
    expect(claude.codexVersion).toBeUndefined()
    expect(claude.initialize).toEqual({ userAgent: 'claude-bridge/2.1.331' })
    expect(await client.req('codex.attach', { agent: 'claude', sinceSeq: 0 })).toMatchObject({
      lastSeq: 0,
      truncated: false,
      accessModes: true,
    })
    expect(await client.req('codex.status', { agent: 'claude' })).toMatchObject({ running: true })
    expect(await client.req('codex.status')).toMatchObject({ running: true })
    client.close()
  }, 30_000)

  it('codex.send 按 agent 分发，响应带/不带 agent 标签，seq 与回放按 agent 隔离', async () => {
    const client = new Client(endpoint)
    expect((await client.hello(token)).t).toBe('welcome')
    // 广播只发给对该 agent 调用过 attach 的客户端。
    await client.req('codex.attach', { agent: 'claude', sinceSeq: 999999 })
    await client.req('codex.attach', { sinceSeq: 999999 })

    client.send({
      t: 'codex.send',
      agent: 'claude',
      msg: { id: 'c-start', method: 'thread/start', params: { cwd: root } },
    })
    const claudeThread = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 'c-start',
    )
    expect(claudeThread.agent).toBe('claude')
    expect(claudeThread.seq).toBeNull()
    const threadId = (((claudeThread.msg as Frame).result as Frame).thread as Frame).id as string
    expect(threadId).toBeTypeOf('string')

    client.send({
      t: 'codex.send',
      msg: { id: 'c-codex', method: 'thread/start', params: { cwd: root } },
    })
    const codexResponse = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 'c-codex',
    )
    expect(codexResponse.agent).toBeUndefined()
    expect(codexResponse.seq).toBeNull()

    client.send({
      t: 'codex.send',
      agent: 'claude',
      msg: {
        id: 'c-turn',
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hi' }] },
      },
    })
    await client.wait((f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 'c-turn')
    await client.wait(
      (f) =>
        f.t === 'codex.recv' &&
        f.agent === 'claude' &&
        (f.msg as Frame)?.method === 'turn/completed',
    )
    const claudeNotes = client.all.filter((f) => f.t === 'codex.recv' && f.agent === 'claude' && typeof f.seq === 'number')
    expect(claudeNotes.map((f) => (f.msg as Frame).method)).toEqual(
      expect.arrayContaining(['turn/started', 'item/agentMessage/delta', 'turn/completed']),
    )
    const claudeSeqs = claudeNotes.map((f) => f.seq as number)
    expect(claudeSeqs[0]).toBe(1)
    expect(claudeSeqs.every((seq, index) => index === 0 || seq > (claudeSeqs[index - 1] as number))).toBe(true)
    // 假 codex 的 tick 广播没有 agent 字段（缺省 codex）。
    const codexNotes = client.all.filter((f) => f.t === 'codex.recv' && f.agent === undefined && typeof f.seq === 'number')
    expect(codexNotes.length).toBeGreaterThan(0)

    const claudeAttach = await client.req('codex.attach', { agent: 'claude', sinceSeq: 0 })
    expect(claudeAttach.lastSeq).toBe(claudeSeqs.at(-1))
    const codexAttach = await client.req('codex.attach', { sinceSeq: 0 })
    expect(codexAttach.lastSeq).toBeGreaterThan(0)
    client.close()
  }, 30_000)

  it('非法 agent 参数返回 params 错误，非法 codex.send.agent 触发协议错误帧', async () => {
    const client = new Client(endpoint)
    expect((await client.hello(token)).t).toBe('welcome')
    const res = await client.req('codex.status', { agent: 'other' }).catch((err: Error) => err)
    expect(res).toBeInstanceOf(Error)
    expect(String((res as Error).message)).toContain('agent')
    client.close()

    const invalid = new Client(endpoint)
    expect((await invalid.hello(token)).t).toBe('welcome')
    invalid.send({ t: 'codex.send', agent: 'other', msg: { id: 1, method: 'thread/list' } })
    const error = await invalid.wait((f) => f.t === 'error')
    expect(error.code).toBe('protocol')
    invalid.close()
  }, 30_000)
})
