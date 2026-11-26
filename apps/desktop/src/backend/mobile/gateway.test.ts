import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerCertificate } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BackendRouter } from '../router'
import type { SecretCipher } from '../secretStore'
import { loadOrCreateCertificate, type MobileCertificate } from './cert'
import {
  checkRpcWhitelist,
  MAX_REQUEST_BYTES,
  MobileGateway,
  mobileEventFromRouter,
  parseBearerToken,
  type GatewayEvent,
} from './gateway'
import { DeviceStore, deviceFilePath, hashToken } from './pairing'
import { MobileSettingsStore, mobileDirectory } from './settings'

type TestResponse = {
  status: number
  text: string
  json(): unknown
}

type EventStreamHandles = {
  ready: Promise<void>
  event: Promise<GatewayEvent>
  close(): void
}

const cipher: SecretCipher = {
  encrypt: async (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: async (encoded) => Buffer.from(encoded, 'base64').toString('utf8'),
}

const PAIR_CODE = 'Pair.Code!'
const LOCAL_TARGET = { id: 'local' as const, kind: 'local' as const, name: '本机' }

let userData = ''
let certificate: MobileCertificate | null = null
let gateway: MobileGateway | null = null
let router: BackendRouter
let deviceStore: DeviceStore
let port = 0
let now = 1000
let identityChecks = 0
let lastServerReq: unknown = null
let lastCodexSend: unknown = null

function httpsOptions(
  path: string,
  method: string,
  headers: Record<string, string | number>
): RequestOptions {
  return {
    host: '127.0.0.1',
    port,
    path,
    method,
    headers,
    ca: certificate?.cert ?? '',
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname: string, peer: PeerCertificate) => {
      identityChecks += 1
      const actual = createHash('sha256').update(peer.raw).digest('hex')
      return actual === (certificate?.fingerprint ?? '')
        ? undefined
        : new Error('证书指纹不匹配')
    },
    agent: false,
  }
}

function requestJson(
  path: string,
  method: string,
  body?: unknown,
  token?: string
): Promise<TestResponse> {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers: Record<string, string | number> = { Accept: 'application/json' }
  if (payload !== null) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    headers['Content-Length'] = Buffer.byteLength(payload)
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return new Promise((resolve, reject) => {
    const req = httpsRequest(httpsOptions(path, method, headers), (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
      })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        text,
        json: () => (text ? JSON.parse(text) as unknown : null),
      }))
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function openEventStream(token: string): EventStreamHandles {
  let resolveReady: () => void = () => undefined
  let rejectReady: (err: Error) => void = () => undefined
  let resolveEvent: (event: GatewayEvent) => void = () => undefined
  let rejectEvent: (err: Error) => void = () => undefined
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const event = new Promise<GatewayEvent>((resolve, reject) => {
    resolveEvent = resolve
    rejectEvent = reject
  })
  let readySettled = false
  let eventSettled = false
  let buffer = ''
  const options = httpsOptions('/events', 'GET', {
    Accept: 'application/x-ndjson',
    Authorization: `Bearer ${token}`,
  })
  const req = httpsRequest(options, (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      const err = new Error(`事件流 HTTP ${res.statusCode}`)
      if (!readySettled) {
        readySettled = true
        rejectReady(err)
      }
      if (!eventSettled) {
        eventSettled = true
        rejectEvent(err)
      }
      return
    }
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let parsed: GatewayEvent | null = null
        try {
          parsed = JSON.parse(line) as GatewayEvent
        } catch {
          // 忽略单个损坏行，继续解析后续 NDJSON。
        }
        if (parsed?.name === 'ping' && !readySettled) {
          readySettled = true
          resolveReady()
        } else if (parsed?.name === 'target.state' && !eventSettled) {
          eventSettled = true
          resolveEvent(parsed)
        }
        newline = buffer.indexOf('\n')
      }
    })
    res.on('end', () => {
      if (!eventSettled) {
        eventSettled = true
        rejectEvent(new Error('事件流提前结束'))
      }
    })
  })
  req.on('error', (err) => {
    if (!readySettled) {
      readySettled = true
      rejectReady(err)
    }
    if (!eventSettled) {
      eventSettled = true
      rejectEvent(err)
    }
  })
  req.end()
  return { ready, event, close: () => req.destroy() }
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'qn-mobile-gateway-'))
  const directory = mobileDirectory(userData)
  certificate = await loadOrCreateCertificate(directory, { commonName: 'localhost' })
  const settings = new MobileSettingsStore(userData, cipher)
  await settings.setPassword(PAIR_CODE)
  deviceStore = new DeviceStore(deviceFilePath(directory), () => now)
  router = new BackendRouter()
  router.register('targets.list', () => [LOCAL_TARGET])
  router.register('server.req', (params) => {
    lastServerReq = params
    return { method: params.method }
  })
  router.register('codex.send', (params) => {
    lastCodexSend = params
  })
  gateway = new MobileGateway({
    router,
    devices: deviceStore,
    getPairingCode: () => settings.getPassword(),
    desktopName: '测试电脑',
    version: '0.0.1',
    now: () => now,
    lockMs: 60_000,
    heartbeatMs: 40,
    bindHost: '127.0.0.1',
  })
  await gateway.start(0, certificate)
  port = gateway.boundPort ?? 0
})

afterAll(async () => {
  await gateway?.stop()
  if (userData) await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('手机网关纯逻辑', () => {
  it('严格限制 RPC 白名单与 Bearer token', () => {
    expect(checkRpcWhitelist('targets.list', {}).ok).toBe(true)
    expect(checkRpcWhitelist('server.req', { method: 'codex.open' }).ok).toBe(true)
    expect(checkRpcWhitelist('targets.remove', {})).toMatchObject({
      ok: false,
      code: 'forbidden',
    })
    expect(checkRpcWhitelist('server.req', { method: 'server.shutdown' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    })
    expect(checkRpcWhitelist('server.req', {})).toMatchObject({
      ok: false,
      code: 'invalid_params',
    })
    const token = 'a'.repeat(64)
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token)
    expect(parseBearerToken('Basic abc')).toBeNull()
  })

  it('只转发手机可见事件，主机指纹确认不泄漏 promptId', () => {
    expect(mobileEventFromRouter('codex.recv', { targetId: 'local', agent: 'claude' }))
      .toEqual({ name: 'codex.recv', payload: { targetId: 'local', agent: 'claude' } })
    expect(mobileEventFromRouter('hostKey.prompt', {
      promptId: 'p1',
      host: '192.168.10.93',
      port: 22,
      fingerprint: 'SHA256:secret',
    })).toEqual({
      name: 'mobile.notice',
      payload: {
        kind: 'hostKey',
        message: '请在电脑上确认主机指纹',
        host: '192.168.10.93',
        port: 22,
      },
    })
    expect(mobileEventFromRouter('secret.internal', {})).toBeNull()
  })
})

describe('手机网关 HTTPS 集成', () => {
  it('探针 → 失败锁定 → 配对 → RPC → 事件 → 撤销全流程', async () => {
    expect(port).toBeGreaterThan(0)
    expect(identityChecks).toBe(0)

    const probe = await requestJson('/probe', 'GET')
    expect(probe.status).toBe(200)
    expect(probe.json()).toMatchObject({
      name: '测试电脑',
      desktopName: '测试电脑',
      version: '0.0.1',
      protocol: 1,
      fingerprint: certificate?.fingerprint,
    })
    expect(identityChecks).toBeGreaterThan(0)

    for (let index = 0; index < 5; index += 1) {
      const failed = await requestJson('/pair', 'POST', {
        code: `wrong-${index}`,
        deviceName: '手机',
      })
      expect(failed.status).toBe(401)
    }
    const locked = await requestJson('/pair', 'POST', {
      code: PAIR_CODE,
      deviceName: '手机',
    })
    expect(locked.status).toBe(429)

    now += 60_001
    const paired = await requestJson('/pair', 'POST', {
      code: PAIR_CODE,
      deviceName: '我的手机',
    })
    expect(paired.status).toBe(200)
    const pairResult = paired.json() as { token: string; desktopName: string }
    expect(pairResult.token).toMatch(/^[0-9a-f]{64}$/)
    expect(pairResult.desktopName).toBe('测试电脑')
    const token = pairResult.token

    const targets = await requestJson('/rpc', 'POST', { method: 'targets.list', params: {} }, token)
    expect(targets.status).toBe(200)
    expect(targets.json()).toEqual([LOCAL_TARGET])

    const forbiddenMethod = await requestJson(
      '/rpc',
      'POST',
      { method: 'targets.remove', params: { id: 'x' } },
      token
    )
    expect(forbiddenMethod.status).toBe(403)
    expect(forbiddenMethod.json()).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    const forbiddenInner = await requestJson(
      '/rpc',
      'POST',
      { method: 'server.req', params: { targetId: 'local', method: 'server.shutdown' } },
      token
    )
    expect(forbiddenInner.status).toBe(403)

    const allowedInner = await requestJson(
      '/rpc',
      'POST',
      { method: 'server.req', params: { targetId: 'local', method: 'ping' } },
      token
    )
    expect(allowedInner.status).toBe(200)
    expect(lastServerReq).toMatchObject({ targetId: 'local', method: 'ping' })

    const agentRpc = await requestJson(
      '/rpc',
      'POST',
      {
        method: 'codex.send',
        params: { targetId: 'local', msg: { method: 'thread/list' } },
        agent: 'claude',
      },
      token
    )
    expect(agentRpc.status).toBe(200)
    expect(lastCodexSend).toMatchObject({ targetId: 'local', agent: 'claude' })

    const tooLarge = await requestJson('/pair', 'POST', {
      code: PAIR_CODE,
      deviceName: '手机',
      padding: 'x'.repeat(MAX_REQUEST_BYTES + 10),
    })
    expect(tooLarge.status).toBe(413)

    const stream = openEventStream(token)
    await stream.ready
    router.emit('target.state', { id: 'local', state: 'ready' })
    expect(await stream.event).toEqual({
      name: 'target.state',
      payload: { id: 'local', state: 'ready' },
    })
    stream.close()

    const rawDevices = await readFile(deviceFilePath(mobileDirectory(userData)), 'utf8')
    expect(rawDevices).not.toContain(token)
    expect(rawDevices).toContain(hashToken(token))

    const devices = await deviceStore.list()
    const deviceId = devices[0]?.id
    if (!deviceId) throw new Error('配对后缺少设备 id')
    await deviceStore.revoke(deviceId)
    gateway?.disconnectDevice(deviceId)
    const revoked = await requestJson('/rpc', 'POST', { method: 'targets.list', params: {} }, token)
    expect(revoked.status).toBe(401)
  }, 20_000)
})
