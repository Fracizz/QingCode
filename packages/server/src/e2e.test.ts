import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, FrameDecoder, encodeFrame } from '@qn/protocol'
import { build, type Plugin } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VERSION } from './version'

type Frame = Record<string, unknown>

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const mainEntry = path.join(srcDir, 'main.ts')
const fakeCodex = path.resolve(srcDir, '../test/fake-codex.mjs')

interface Waiter {
  pred: (frame: Frame) => boolean
  resolve: (frame: Frame) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 通过 connect --stdio 子进程与 daemon 通信的测试客户端。 */
class Bridge {
  readonly child: ChildProcess
  readonly all: Frame[] = []
  lastSeq = 0
  private readonly decoder = new FrameDecoder()
  private readonly queue: Frame[] = []
  private readonly waiters: Waiter[] = []
  private reqId = 0
  private stderr = ''

  constructor(bundle: string, stateDir: string) {
    this.child = spawn(
      process.execPath,
      [bundle, 'connect', '--stdio', '--state-dir', stateDir],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child.stdout?.on('data', (chunk: Buffer) => {
      let frames: unknown[]
      try {
        frames = this.decoder.push(chunk)
      } catch {
        return
      }
      for (const frame of frames) {
        if (isRecord(frame)) this.onFrame(frame)
      }
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
    })
    bridges.add(this)
  }

  private onFrame(frame: Frame): void {
    this.all.push(frame)
    if (frame.t === 'codex.recv' && typeof frame.seq === 'number') {
      this.lastSeq = Math.max(this.lastSeq, frame.seq)
    }
    const index = this.waiters.findIndex((w) => w.pred(frame))
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1)
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
      return
    }
    this.queue.push(frame)
  }

  send(msg: unknown): void {
    this.child.stdin?.write(Buffer.from(encodeFrame(msg)))
  }

  take(pred: (frame: Frame) => boolean, timeoutMs = 8000): Promise<Frame> {
    const index = this.queue.findIndex(pred)
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0] as Frame)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new Error(`等待消息超时；stderr=${this.stderr}`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  async hello(token: string, protocol = PROTOCOL_VERSION, timeoutMs = 8000): Promise<Frame> {
    this.send({ t: 'hello', protocol, token, client: { name: 'e2e', version: '0.0.1' } })
    return this.take((f) => f.t === 'welcome' || f.t === 'error', timeoutMs)
  }

  async req(method: string, params?: unknown, timeoutMs = 8000): Promise<Frame> {
    const id = ++this.reqId
    this.send({
      t: 'req',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    })
    const res = await this.take((f) => f.t === 'res' && f.id === id, timeoutMs)
    if (res.ok !== true) {
      const error = isRecord(res.error) ? String(res.error.message) : '未知错误'
      throw new Error(`${method} 失败: ${error}`)
    }
    return (res.result ?? null) as Frame
  }

  close(): void {
    try {
      this.child.stdin?.destroy()
    } catch {
      // 已退出。
    }
    this.child.kill()
    bridges.delete(this)
  }
}

const bridges = new Set<Bridge>()
let root = ''
let stateDir = ''
let bundle = ''
let fakeLog = ''
let token = ''
let daemonPid = 0
let codexPath = ''

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(50)
  }
  throw new Error('等待条件超时')
}

function alive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recvMsg(frame: Frame): Frame {
  return isRecord(frame.msg) ? frame.msg : {}
}

describe('server 端到端（daemon + connect --stdio + codex 中继）', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-server-e2e-'))
    stateDir = path.join(root, 'state')
    bundle = path.join(root, 'qn-server.cjs')
    fakeLog = path.join(root, 'fake-codex.log')
    codexPath = JSON.stringify([process.execPath, fakeCodex, fakeLog])
    fs.mkdirSync(stateDir, { recursive: true })

    // 与 build.mjs 同配置，但产物落在临时目录，避免影响其它任务的 resources/。
    await build({
      entryPoints: [mainEntry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      logLevel: 'silent',
    })

    const result = spawnSync(
      process.execPath,
      [bundle, 'ensure', '--state-dir', stateDir],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    )
    if (result.status !== 0) {
      throw new Error(`ensure 失败: ${result.status} ${result.stderr}`)
    }
    const parsed = JSON.parse(result.stdout.trim()) as {
      token: string
      version: string
      pid: number
      started: boolean
    }
    token = parsed.token
    daemonPid = parsed.pid
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.started).toBe(true)
    expect(parsed.pid).toBeGreaterThan(0)
  }, 90_000)

  afterAll(async () => {
    const shutdown = new Bridge(bundle, stateDir)
    const welcome = await shutdown.hello(token, PROTOCOL_VERSION, 800).catch(() => null)
    if (welcome?.t === 'welcome') {
      await shutdown.req('server.shutdown').catch(() => null)
    }
    shutdown.close()
    await until(() => !alive(daemonPid), 5_000).catch(() => null)
    if (alive(daemonPid)) {
      try {
        process.kill(daemonPid)
      } catch {
        // 已退出。
      }
    }
    for (const bridge of [...bridges]) bridge.close()
    await sleep(150)
    fs.rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('version / hello-welcome / ping / fs.home', async () => {
    const version = spawnSync(process.execPath, [bundle, 'version'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(version.status).toBe(0)
    expect(JSON.parse(version.stdout.trim())).toMatchObject({ protocol: PROTOCOL_VERSION })

    const bridge = new Bridge(bundle, stateDir)
    const hello = await bridge.hello(token)
    expect(hello.t).toBe('welcome')
    expect(hello.protocol).toBe(PROTOCOL_VERSION)
    expect(hello.pid).toBe(daemonPid)

    expect(await bridge.req('ping')).toMatchObject({ protocol: PROTOCOL_VERSION })
    expect((await bridge.req('fs.home')).path).toBeTypeOf('string')
    bridge.close()

    for (const flag of ['--replace', '--force-replace']) {
      const same = spawnSync(
        process.execPath,
        [bundle, 'ensure', '--state-dir', stateDir, flag],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      )
      expect(same.status).toBe(0)
      expect(JSON.parse(same.stdout.trim())).toMatchObject({ started: false, pid: daemonPid, token, version: VERSION })
    }
  }, 30_000)

  it('system.metrics 返回目标机的 CPU 和内存占用', async () => {
    const bridge = new Bridge(bundle, stateDir)
    await bridge.hello(token)
    const metrics = await bridge.req('system.metrics')
    bridge.close()

    expect(metrics.cpuThreads).toBe(os.cpus().length)
    expect(metrics.cpuUsage).toBeGreaterThanOrEqual(0)
    expect(metrics.cpuUsage).toBeLessThanOrEqual(100)
    expect(metrics.memoryTotal).toBe(os.totalmem())
    expect(metrics.memoryUsed).toBeGreaterThanOrEqual(0)
    expect(metrics.memoryUsed).toBeLessThanOrEqual(os.totalmem())
  })

  it('codex.open → 请求 id 还原 / 通知广播 / 审批首响应 / 重连 attach', async () => {
    const a = new Bridge(bundle, stateDir)
    expect((await a.hello(token)).t).toBe('welcome')

    // 测试钩子：codexPath 传 JSON 数组 [可执行文件, ...参数]。
    const opened = await a.req('codex.open', { codexPath }, 15_000)
    expect(opened.lastSeq).toBeTypeOf('number')
    expect(opened.codexVersion).toBe('0.172.0')
    expect(opened.initialize).toMatchObject({ userAgent: 'fake-codex/0.172.0' })

    const attached = await a.req('codex.attach', { sinceSeq: opened.lastSeq })
    expect(attached.truncated).toBe(false)

    a.send({ t: 'codex.send', msg: { id: 7, method: 'thread/start', params: { cwd: root } } })
    const forwarded = await a.take(
      (f) => f.t === 'codex.recv' && recvMsg(f).id === 7 && f.seq === null,
    )
    expect(recvMsg(forwarded).result).toMatchObject({ thread: { id: 'thread-1' } })

    await a.take((f) => f.t === 'codex.recv' && recvMsg(f).method === 'turn/started')
    await a.take((f) => f.t === 'codex.recv' && recvMsg(f).method === 'item/agentMessage/delta')
    const approval = await a.take(
      (f) => f.t === 'codex.recv' && recvMsg(f).method === 'item/commandExecution/requestApproval',
    )
    expect(recvMsg(approval).id).toBe('approval-1')
    expect(approval.seq).toBeTypeOf('number')

    await until(async () => {
      const status = await a.req('codex.status')
      return status.running === true && Number(status.activeTurns) >= 1
    })

    // 两个客户端响应同一审批：第一个生效，其余忽略。
    a.send({ t: 'codex.send', msg: { id: 'approval-1', result: { decision: 'accept' } } })
    a.send({ t: 'codex.send', msg: { id: 'approval-1', result: { decision: 'decline' } } })
    await a.take((f) => f.t === 'codex.recv' && recvMsg(f).method === 'turn/completed')
    await sleep(200)
    const lines = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('accept')

    await until(async () => Number((await a.req('codex.status')).activeTurns) === 0)

    // 记录断开时的 seq，断开期间假 codex 继续产生 tick，再用新连接回放。
    const since = a.lastSeq
    a.close()
    await sleep(250)

    const b = new Bridge(bundle, stateDir)
    expect((await b.hello(token)).t).toBe('welcome')
    const replay = await b.req('codex.attach', { sinceSeq: since })
    expect(replay.lastSeq).toBeGreaterThan(since)
    expect(replay.truncated).toBe(false)
    const replayed = await b.take(
      (f) => f.t === 'codex.recv' && typeof f.seq === 'number' && f.seq > since,
    )
    expect(replayed.seq).toBeGreaterThan(since)
    // 回放帧必须在 attach 的 res 之前下发。
    const replayIndex = b.all.indexOf(replayed)
    const resIndex = b.all.findIndex((f) => f.t === 'res' && f.result === replay)
    expect(replayIndex).toBeGreaterThanOrEqual(0)
    expect(resIndex).toBeGreaterThan(replayIndex)
    b.close()
  }, 60_000)

  it('codex 退出时未完成请求报错、广播 codex.exited，且 codex.open 可重启', async () => {
    const bridge = new Bridge(bundle, stateDir)
    expect((await bridge.hello(token)).t).toBe('welcome')
    await bridge.req('codex.open', { codexPath }, 15_000)

    bridge.send({ t: 'codex.send', msg: { id: 99, method: 'fake/hang' } })
    bridge.send({ t: 'codex.send', msg: { method: 'fake/exit' } })

    const failed = await bridge.take(
      (f) => f.t === 'codex.recv' && recvMsg(f).id === 99 && isRecord(recvMsg(f).error),
    )
    expect(failed.seq).toBeNull()
    expect(recvMsg(failed).error).toMatchObject({ code: -32000 })
    const exited = await bridge.take((f) => f.t === 'evt' && f.name === 'codex.exited')
    expect(exited.payload).toMatchObject({ code: 3 })

    const reopened = await bridge.req('codex.open', { codexPath }, 15_000)
    expect(reopened.initialize).toMatchObject({ userAgent: 'fake-codex/0.172.0' })
    bridge.close()
  }, 60_000)

  const hasPythonPty = process.platform !== 'win32' &&
    spawnSync('python3', ['-I', '-c', 'import pty, termios'], { timeout: 5000 }).status === 0
  it.each([
    { terminal: false, force: false, label: '空闲时重启' },
    { terminal: true, force: false, label: '保留活跃终端，关闭终端后重启' },
    { terminal: true, force: true, label: '强制更新时中断活跃终端并重启' },
  ].filter(({ terminal }) => !terminal || hasPythonPty))('ensure 版本不同时 $label', async ({ terminal, force }) => {
    const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-server-replace-'))
    const oldBundle = path.join(oldRoot, 'qn-server-old.cjs')
    const replaceState = path.join(oldRoot, 'state')
    let replacePid = 0
    try {
      // 用插件把 package.json 内联版本换成旧版，模拟已部署的旧 daemon。
      const oldVersion: Plugin = {
        name: 'old-version',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.\.\/package\.json$/ }, (args) => ({
            path: args.path,
            namespace: 'old-version',
          }))
          pluginBuild.onLoad({ filter: /.*/, namespace: 'old-version' }, () => ({
            contents: JSON.stringify({ version: '0.0.0' }),
            loader: 'json',
          }))
        },
      }
      await build({
        entryPoints: [mainEntry],
        outfile: oldBundle,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        plugins: [oldVersion],
        logLevel: 'silent',
      })

      const old = spawnSync(
        process.execPath,
        [oldBundle, 'ensure', '--state-dir', replaceState],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      )
      expect(old.status).toBe(0)
      const oldInfo = JSON.parse(old.stdout.trim()) as { version: string; pid: number; token: string }
      replacePid = oldInfo.pid
      expect(oldInfo.version).toBe('0.0.0')

      if (terminal) {
        const bridge = new Bridge(oldBundle, replaceState)
        try {
          expect((await bridge.hello(oldInfo.token)).t).toBe('welcome')
          const opened = await bridge.req('term.open', { cwd: oldRoot, shell: '/bin/sh', backend: 'python' })
          const termId = opened.termId
          await expect(bridge.req('server.shutdown', { whenIdle: true })).rejects.toThrow('有进行中的对话或终端')
          const deferred = spawnSync(
            process.execPath,
            [bundle, 'ensure', '--state-dir', replaceState, '--replace'],
            { encoding: 'utf8', timeout: 30_000, windowsHide: true },
          )
          expect(deferred.status).toBe(0)
          expect(JSON.parse(deferred.stdout)).toMatchObject({
            started: false,
            version: oldInfo.version,
            pid: oldInfo.pid,
            stale: true,
          })
          expect(await bridge.req('term.attach', { termId, sinceSeq: 0 })).toMatchObject({ alive: true })
          if (!force) await bridge.req('term.close', { termId })
        } finally {
          bridge.close()
        }
      }

      const replaced = spawnSync(
        process.execPath,
        [bundle, 'ensure', '--state-dir', replaceState, force ? '--force-replace' : '--replace'],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      )
      expect(replaced.status).toBe(0)
      const info = JSON.parse(replaced.stdout.trim()) as {
        version: string
        pid: number
        token: string
        started: boolean
      }
      replacePid = info.pid
      expect(info.started).toBe(true)
      expect(info.version).toBe(VERSION)
      expect(info.pid).not.toBe(oldInfo.pid)
      expect(info.token).toBe(oldInfo.token)

      const bridge = new Bridge(bundle, replaceState)
      expect((await bridge.hello(info.token)).t).toBe('welcome')
      if (force) {
        expect(await bridge.req('term.list')).toMatchObject({ terminals: [] })
        await until(() => !alive(oldInfo.pid), 5_000)
      }
      expect(await bridge.req('server.shutdown')).toEqual({})
      bridge.close()
      await until(() => !alive(info.pid), 5_000)
    } finally {
      if (replacePid && alive(replacePid)) process.kill(replacePid)
      fs.rmSync(oldRoot, { recursive: true, force: true })
    }
  }, 90_000)

  it('Codex 定时会话等待用户审批，客户端断开后继续由 daemon 托管', async () => {
    const scheduledState = path.join(root, 'schedule-state')
    const windows = process.platform === 'win32'
    const executable = path.join(root, windows ? 'scheduled-codex.cmd' : 'scheduled-codex')
    const quote = (value: string) => windows
      ? '"' + value.replace(/%/g, '%%') + '"'
      : "'" + value.replace(/'/g, "'\\''") + "'"
    const command = [process.execPath, fakeCodex].map(quote).join(' ')
    fs.writeFileSync(executable, windows ? '@echo off\r\n' + command + ' %*\r\n'
      : '#!/bin/sh\nexec ' + command + ' "$@"\n', { mode: 0o700 })

    const started = spawnSync(process.execPath, [bundle, 'ensure', '--state-dir', scheduledState], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    expect(started.status).toBe(0)
    const info = JSON.parse(started.stdout) as { pid: number; token: string }
    const creator = new Bridge(bundle, scheduledState)
    let viewer: Bridge | undefined
    try {
      await creator.hello(info.token)
      const task = await creator.req('schedule.upsert', {
        cwd: root, name: '检查报告', agent: 'codex', prompt: 'Run the test prompt', enabled: false,
        cadence: { frequency: 'daily', time: '09:00', timeZone: 'UTC' }, runtime: { codexPath: executable },
      })
      const params = { cwd: root, id: task.id }
      const run = await creator.req('schedule.runNow', params)
      expect(run.runId).toBeTypeOf('string')
      creator.close()

      viewer = new Bridge(bundle, scheduledState)
      const client = viewer
      await client.hello(info.token)
      await until(async () => {
        const runs = await client.req('schedule.runs', params) as unknown as Array<{ status: string }>
        return runs[0]?.status === 'waiting'
      })
      await expect(client.req('server.shutdown', { whenIdle: true })).rejects.toThrow('有进行中的')
      await client.req('codex.open', { codexPath: executable })
      await client.req('codex.attach', { sinceSeq: 0 })
      await client.take((frame) => frame.t === 'codex.recv' && recvMsg(frame).id === 'scheduled-approval')
      client.send({ t: 'codex.send', msg: { id: 'scheduled-approval', result: { decision: 'decline' } } })
      await client.take((frame) => frame.t === 'codex.recv' && recvMsg(frame).method === 'turn/completed')
      expect(await client.req('schedule.runs', params)).toMatchObject([
        { id: run.runId, agent: 'codex', threadId: 'scheduled-thread', status: 'succeeded' },
      ])
    } finally {
      creator.close()
      if (viewer) {
        await viewer.req('server.shutdown').catch(() => undefined)
        viewer.close()
      }
      await until(() => !alive(info.pid), 1000).catch(() => undefined)
      if (alive(info.pid)) process.kill(info.pid)
    }
  }, 30_000)

  it('token 错 / protocol 不符 / 第二个 daemon 自动退出 / server.shutdown', async () => {
    const badToken = new Bridge(bundle, stateDir)
    expect(await badToken.hello('b'.repeat(64))).toMatchObject({ t: 'error', code: 'auth' })
    badToken.close()

    const badProtocol = new Bridge(bundle, stateDir)
    expect(await badProtocol.hello(token, 2)).toMatchObject({ t: 'error', code: 'protocol' })
    badProtocol.close()

    const second = spawnSync(
      process.execPath,
      [bundle, 'daemon', '--state-dir', stateDir],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    )
    expect(second.status).toBe(0)

    const bridge = new Bridge(bundle, stateDir)
    expect((await bridge.hello(token)).t).toBe('welcome')
    expect(await bridge.req('server.shutdown')).toEqual({})
    await until(() => !alive(daemonPid), 5_000)
    bridge.close()
  }, 60_000)
})
