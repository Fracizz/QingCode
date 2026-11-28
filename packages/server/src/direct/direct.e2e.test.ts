import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { decodeDirectCode, encodeFrame, FrameDecoder, PROTOCOL_VERSION } from '@qn/protocol'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 端到端：daemon 内置直连监听 + 每客户端授权 + 撤销断开 + 管理方法禁止。

type Frame = Record<string, unknown>

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const mainEntry = path.resolve(srcDir, '../main.ts')

let root = ''
let stateDir = ''
let bundle = ''
let port = 0

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...args, '--state-dir', stateDir], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function runJson<T>(...args: string[]): T {
  const result = run(...args)
  if (result.status !== 0) throw new Error(`${args.join(' ')} 失败: ${result.stderr}`)
  return JSON.parse(result.stdout.trim()) as T
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const value = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(value))
    })
  })
}

class TlsClient {
  readonly frames: Frame[] = []
  closed = false
  private readonly decoder = new FrameDecoder()
  private readonly listeners: Array<() => void> = []

  private constructor(readonly socket: tls.TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) this.frames.push(frame as Frame)
      this.listeners.splice(0).forEach((fn) => fn())
    })
    socket.on('close', () => {
      this.closed = true
      this.listeners.splice(0).forEach((fn) => fn())
    })
    socket.on('error', () => undefined)
  }

  static open(): Promise<TlsClient> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
      socket.once('secureConnect', () => resolve(new TlsClient(socket)))
      socket.once('error', reject)
    })
  }

  send(msg: unknown): void {
    this.socket.write(Buffer.from(encodeFrame(msg)))
  }

  async wait(pred: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame | 'closed'> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      if (this.closed) return 'closed'
      if (Date.now() > deadline) throw new Error('等待帧超时')
      await new Promise<void>((resolve) => {
        this.listeners.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }

  hello(token: string): void {
    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, token, client: { name: 'test', version: '0' } })
  }

  close(): void {
    this.socket.destroy()
  }
}

describe('daemon 直连', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-direct-e2e-'))
    stateDir = path.join(root, 'state')
    bundle = path.join(root, 'qn-server.cjs')
    await build({
      entryPoints: [mainEntry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      logLevel: 'silent',
    })
    port = await freePort()
  }, 90_000)

  afterAll(() => {
    // 关闭直连后 daemon 会按空闲策略退出；这里直接停掉。
    run('direct', 'disable')
    const ensured = run('ensure')
    if (ensured.status === 0) {
      const pid = (JSON.parse(ensured.stdout.trim()) as { pid: number }).pid
      try {
        process.kill(pid)
      } catch {
        // 已退出。
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('grant 需要先 enable', () => {
    const result = run('direct', 'grant', '--name', 'x')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('direct enable')
  })

  it('enable → grant → 授权 token 可握手，主 token 与错误 token 不行，撤销后断开', async () => {
    const status = runJson<{ listening: boolean; fingerprint: string }>('direct', 'enable', '--listen', `127.0.0.1:${String(port)}`)
    expect(status.listening).toBe(true)
    expect(status.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    const granted = runJson<{ grantId: string; code: string }>('direct', 'grant', '--name', 'laptop')
    const info = decodeDirectCode(granted.code)
    expect(info?.port).toBe(port)
    expect(info?.hosts).toEqual(['127.0.0.1'])
    expect(info?.fingerprint).toBe(status.fingerprint)

    // 主 token 只给本机 IPC 用，直连不认。
    const master = fs.readFileSync(path.join(stateDir, 'run', 'token'), 'utf8').trim()
    const bad = await TlsClient.open()
    bad.hello(master)
    const rejected = await bad.wait((f) => f.t === 'error')
    expect(rejected).toMatchObject({ t: 'error', code: 'auth' })
    bad.close()

    const good = await TlsClient.open()
    good.hello(info?.token ?? '')
    expect(await good.wait((f) => f.t === 'welcome')).toMatchObject({ t: 'welcome' })
    good.send({ t: 'req', id: 1, method: 'ping' })
    expect(await good.wait((f) => f.t === 'res' && f.id === 1)).toMatchObject({ ok: true })
    good.send({ t: 'req', id: 2, method: 'server.shutdown' })
    expect(await good.wait((f) => f.t === 'res' && f.id === 2)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    good.send({ t: 'req', id: 3, method: 'plugins.rgStatus' })
    expect(await good.wait((f) => f.t === 'res' && f.id === 3)).toMatchObject({ ok: true, result: { source: expect.any(String) } })
    for (const [id, method] of [[4, 'plugins.rgInstall'], [5, 'plugins.rgRemove']] as const) {
      good.send({ t: 'req', id, method })
      expect(await good.wait((f) => f.t === 'res' && f.id === id)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }

    const listed = runJson<{ grants: Array<{ id: string; name: string }> }>('direct', 'status')
    expect(listed.grants).toEqual([expect.objectContaining({ id: granted.grantId, name: 'laptop' })])

    runJson('direct', 'revoke', '--id', granted.grantId)
    const after = await good.wait((f) => f.t === 'error' && f.code === 'auth', 5000)
    expect(after === 'closed' || (typeof after === 'object' && after.code === 'auth')).toBe(true)
    good.close()
  }, 60_000)

  it('disable 后停止监听', async () => {
    const status = runJson<{ listening: boolean; enabled: boolean }>('direct', 'disable')
    expect(status).toMatchObject({ listening: false, enabled: false })
    await expect(TlsClient.open()).rejects.toThrow()
  }, 30_000)
})
