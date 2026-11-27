/**
 * pi 端到端：daemon + 假 pi 子进程（node 脚本模拟 RPC），跑通
 * open → thread/start → turn/start → 通知 → turn/completed。
 * 真实 pi 的集成测试默认跳过，只有 QN_PI_E2E=1 时才跑（会消耗用户账号额度）。
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
import { PiRpcProcess } from './rpc'
import { resolvePiExecutable } from './resolve'

type Frame = Record<string, unknown>
type Predicate = (frame: Frame) => boolean

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(srcDir, '..')
const mainEntry = path.join(serverDir, 'main.ts')
const fakePi = path.join(srcDir, 'fixtures', 'fake-pi.mjs')

class Client {
  readonly socket: net.Socket
  readonly all: Frame[] = []
  private readonly decoder = new FrameDecoder()
  private reqId = 0

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
      client: { name: 'pi-e2e', version: '0.0.1' },
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

  wait(pred: Predicate, timeoutMs = 10_000): Promise<Frame> {
    const existing = this.all.find(pred)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poller)
        reject(new Error(`等待帧超时；最近帧 ${JSON.stringify(this.all.slice(-8))}`))
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
let daemonStderr = ''
let token = ''
let endpoint = ''
let piPath = ''

describe('pi 桥端到端（daemon + 假 pi RPC）', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-pi-e2e-'))
    stateDir = path.join(root, 'state')
    const sessionsDir = path.join(root, 'sessions')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(sessionsDir, { recursive: true })
    bundle = path.join(root, 'qn-server.cjs')
    piPath = JSON.stringify([process.execPath, fakePi])

    await build({
      entryPoints: [mainEntry],
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
    daemon = spawn(process.execPath, [bundle, 'daemon', '--state-dir', stateDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 只读隔离的临时会话目录，避免扫到用户真实会话。
      env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionsDir },
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
  }, 90_000)

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

  it('open 返回 capabilities / initialize:null，attach 带 pi 标签', async () => {
    const client = new Client(endpoint)
    expect((await client.hello(token)).t).toBe('welcome')
    const opened = await client.req('codex.open', { agent: 'pi', piPath })
    expect(opened.initialize).toBeNull()
    expect(opened.capabilities).toEqual({ approvals: false, rateLimits: false, ephemeralNoTools: true })
    expect(opened.agentVersion).toBe('test')
    expect(opened.lastSeq).toBe(0)
    expect(await client.req('codex.attach', { agent: 'pi', sinceSeq: 0 })).toMatchObject({
      lastSeq: 0,
      truncated: false,
    })
    expect(await client.req('codex.status', { agent: 'pi' })).toMatchObject({ running: true })
    client.close()
  }, 30_000)

  it('open → thread/start → turn/start → 通知 → turn/completed', async () => {
    const client = new Client(endpoint)
    expect((await client.hello(token)).t).toBe('welcome')
    await client.req('codex.open', { agent: 'pi', piPath })
    await client.req('codex.attach', { agent: 'pi', sinceSeq: 0 })

    client.send({
      t: 'codex.send',
      agent: 'pi',
      msg: { id: 't-start', method: 'thread/start', params: { cwd: root } },
    })
    const started = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 't-start',
    )
    expect(started.agent).toBe('pi')
    expect(started.seq).toBeNull()
    const threadId = (((started.msg as Frame).result as Frame).thread as Frame).id as string
    expect(threadId).toBe('fake-pi-session')

    client.send({
      t: 'codex.send',
      agent: 'pi',
      msg: {
        id: 't-turn',
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '列出当前目录' }] },
      },
    })
    await client.wait((f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 't-turn')
    const turnStarted = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.method === 'turn/started',
    )
    expect(turnStarted.agent).toBe('pi')
    expect(typeof turnStarted.seq).toBe('number')

    const delta = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.method === 'item/agentMessage/delta',
    )
    expect(delta.agent).toBe('pi')
    const command = await client.wait(
      (f) =>
        f.t === 'codex.recv' &&
        (f.msg as Frame)?.method === 'item/completed' &&
        ((f.msg as Frame).params as Frame)?.item !== undefined &&
        (((f.msg as Frame).params as Frame).item as Frame)?.type === 'commandExecution',
    )
    const item = ((command.msg as Frame).params as Frame).item as Frame
    expect(item.command).toBe('ls -la')
    expect(item.status).toBe('completed')

    const completed = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.method === 'turn/completed',
    )
    expect(((completed.msg as Frame).params as Frame).turn).toMatchObject({ status: 'completed' })
    const usage = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.method === 'thread/tokenUsage/updated',
    )
    expect(((usage.msg as Frame).params as Frame).tokenUsage).toBeTypeOf('object')

    const notes = client.all.filter(
      (f) => f.t === 'codex.recv' && f.agent === 'pi' && typeof f.seq === 'number',
    )
    expect(notes.some((f) => String((f.msg as Frame).method).includes('requestApproval'))).toBe(false)

    const status = await client.req('codex.status', { agent: 'pi' })
    expect(status.activeTurns).toBe(0)
    client.close()
  }, 40_000)

  it('不支持的方法返回 -32601，thread/list 与 thread/read 可用', async () => {
    const cwd = path.join(root, 'past-project')
    fs.mkdirSync(cwd)
    const historyId = 'old-pi-session'
    fs.writeFileSync(path.join(root, 'sessions', `${historyId}.jsonl`), JSON.stringify({
      type: 'session', id: historyId, cwd, version: 3, timestamp: '2026-11-25T10:00:00.000Z',
    }) + '\n')
    const client = new Client(endpoint)
    expect((await client.hello(token)).t).toBe('welcome')
    await client.req('codex.open', { agent: 'pi', piPath })

    client.send({
      t: 'codex.send',
      agent: 'pi',
      msg: { id: 'unsupported', method: 'account/rateLimits/read', params: {} },
    })
    const error = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 'unsupported',
    )
    expect(((error.msg as Frame).error as Frame).code).toBe(-32601)

    client.send({
      t: 'codex.send',
      agent: 'pi',
      msg: { id: 'list', method: 'thread/list', params: { cwd: [root, cwd] } },
    })
    const listed = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 'list',
    )
    expect(((listed.msg as Frame).result as Frame).data).toEqual([expect.objectContaining({ id: historyId, cwd })])

    client.send({
      t: 'codex.send',
      agent: 'pi',
      msg: { id: 'read', method: 'thread/read', params: { threadId: historyId } },
    })
    const read = await client.wait(
      (f) => f.t === 'codex.recv' && (f.msg as Frame)?.id === 'read',
    )
    expect(((read.msg as Frame).result as Frame).thread).toMatchObject({
      id: historyId,
      cwd,
      turns: [{ items: [expect.objectContaining({ type: 'userMessage' }), expect.objectContaining({ type: 'agentMessage' })] }],
    })
    client.close()
  }, 30_000)
})

describe.skipIf(process.env.QN_PI_E2E !== '1')('真实 pi 集成（QN_PI_E2E=1）', () => {
  it('驱动用户已安装的 pi 走完一次最小 prompt', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-pi-real-'))
    const resolved = resolvePiExecutable()
    const rpc = new PiRpcProcess({
      command: { command: resolved.command, args: resolved.args, shell: resolved.shell },
      cwd,
      // 集成测试不加载扩展/MCP，也不落盘会话，避免副作用。
      extraArgs: [
        '--no-session',
        '--no-extensions',
        '--no-mcp',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
      ],
      log: () => undefined,
    })
    let settle!: (record: Frame) => void
    const settled = new Promise<Frame>((resolve) => {
      settle = resolve
    })
    let timeout: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('等待 agent_settled 超时')), 90_000)
    })
    rpc.onEvent((record) => {
      if (record.type === 'agent_settled') settle(record)
    })
    rpc.start()
    try {
      const state = await rpc.command('get_state')
      expect(state.success).toBe(true)
      const prompt = await rpc.command('prompt', { message: '列出当前目录' })
      expect(prompt.success).toBe(true)
      const done = await Promise.race([settled, timeoutPromise])
      expect(done.type).toBe('agent_settled')
    } finally {
      if (timeout) clearTimeout(timeout)
      rpc.close()
      // Windows 上 pi 进程退出前仍持有 cwd，等它收尾再删临时目录。
      await sleep(2_000)
      try {
        fs.rmSync(cwd, { recursive: true, force: true })
      } catch {
        // 进程刚退出时目录可能仍被占用；临时目录交给系统清理即可。
      }
    }
  }, 120_000)
})
