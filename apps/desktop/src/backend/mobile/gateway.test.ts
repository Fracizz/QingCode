import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerCertificate } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSettings, BackendParams } from '../../shared/backendApi'
import { defaultAppSettings } from '../settings/appSettings'
import { BackendRouter, type WirePort } from '../router'
import type { SecretCipher } from '../secretStore'
import { loadOrCreateCertificate, type MobileCertificate } from './cert'
import {
  checkRpcWhitelist,
  injectAgentPath,
  MAX_REQUEST_BYTES,
  mobileAgentsFromSettings,
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
const APP_SETTINGS: AppSettings = {
  general: {
    ...defaultAppSettings().general, autoConnectLast: false, defaultAgent: 'claude', globalAccessMode: 'auto',
  },
  agents: {
    local: {
      codex: { enabled: true, path: '  C:\\tools\\codex.exe  ', configDir: 'C:\\Users\\me\\.codex' },
      claude: { enabled: true, path: 'C:\\Users\\me\\.local\\bin\\claude.exe', configDir: 'D:\\claude-cfg' },
      pi: { enabled: false, path: '' },
    },
    'ssh-93': { claude: { enabled: false } },
  },
}

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
let agentSettingsAvailable = true
let handleCodexRequest: ((params: BackendParams<'codex.send'>) => void) | undefined

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

function openEventStream(token: string, accept = (event: GatewayEvent) => event.name === 'target.state'): EventStreamHandles {
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
        } else if (parsed && accept(parsed) && !eventSettled) {
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
  router.register('projects.list', ({ targetId }) => targetId === 'local'
    ? [
        { id: 'test-project', targetId, path: '/project', name: '测试项目', lastOpenedAt: 0, trusted: true },
        { id: 'hidden-project', targetId, path: '/hidden', name: '隐藏项目', lastOpenedAt: 0, trusted: true, hidden: true },
      ]
    : [])
  router.register('server.req', (params) => {
    lastServerReq = params
    if (params.method === 'term.open') return params.params
    if (params.method === 'codex.open' && params.targetId === 'ssh-93') {
      return { capabilities: { accessModes: true } }
    }
    if (params.method === 'codex.attach' && params.targetId === 'local') {
      return { lastSeq: 4, truncated: false, accessModes: (params.params as { agent?: string })?.agent !== 'pi' }
    }
    return { method: params.method }
  })
  router.register('codex.send', (params) => {
    lastCodexSend = params
    handleCodexRequest?.(params)
  })
  router.register('settings.get', () => {
    if (!agentSettingsAvailable) throw new Error('设置暂不可读')
    return APP_SETTINGS
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

  it('server.req 只放行只读文件方法，Git 与写方法一律拒绝', () => {
    expect(checkRpcWhitelist('server.req', { targetId: 'local', method: 'fs.read' }).ok).toBe(true)
    for (const method of [
      'git.status',
      'git.diff',
      'fs.write',
      'fs.delete',
      'fs.mkdir',
      'fs.createFile',
      'fs.rename',
      'fs.watch',
      'fs.search',
      'git.stage',
      'git.unstage',
      'git.discard',
      'git.commit',
      'git.switch',
      'git.push',
      'git.pull',
      'git.fetch',
      'git.show',
      'run.start',
      'run.stop',
      'agent.probe',
      'direct.reload',
    ]) {
      expect(checkRpcWhitelist('server.req', { targetId: 'local', method })).toMatchObject({
        ok: false,
        code: 'forbidden',
      })
    }
    expect(checkRpcWhitelist('mobile.agents', {}).ok).toBe(true)
    expect(checkRpcWhitelist('settings.get', {})).toMatchObject({ ok: false, code: 'forbidden' })
    expect(checkRpcWhitelist('settings.save', {})).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('codex.send 里只放行手机用到的 qingcode 方法，并要求会话与任务 ID', () => {
    const send = (method: string, params?: unknown) =>
      checkRpcWhitelist('codex.send', { targetId: 'local', agent: 'claude', msg: { id: 'c1', method, params } })
    expect(send('qingcode/backgroundTasks/list', { threadId: 't' }).ok).toBe(true)
    expect(send('qingcode/backgroundTasks/stop', { threadId: 't', taskId: 'build' }).ok).toBe(true)
    expect(send('qingcode/commands/list', { threadId: 't' }).ok).toBe(true)
    expect(send('qingcode/mcp/status', { threadId: 't' }).ok).toBe(true)
    expect(send('mcpServerStatus/list', { threadId: 't', detail: 'toolsAndAuthOnly' }).ok).toBe(true)
    for (const [method, params] of [
      ['qingcode/backgroundTasks/list', undefined],
      ['qingcode/commands/list', { threadId: '' }],
      ['qingcode/mcp/status', {}],
      ['mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }],
      ['mcpServerStatus/list', { threadId: 't', detail: 'full' }],
      ['qingcode/backgroundTasks/stop', { threadId: 't' }],
      ['qingcode/backgroundTasks/stop', { threadId: 't', taskId: 7 }],
    ] as const) {
      expect(send(method, params)).toMatchObject({ ok: false, code: 'invalid_params' })
    }
    // 文件回滚只在电脑上提供，试运行也不放行；新增的扩展方法默认拒绝。
    for (const method of ['qingcode/files/rewind', 'qingcode/anything']) {
      expect(send(method, { threadId: 't', turnId: 'u', dryRun: true })).toMatchObject({ ok: false, code: 'forbidden' })
    }
    expect(send('thread/read', { threadId: 't' }).ok).toBe(true)
  })

  it('mobile.agents 只返回启用状态与默认 Agent，不含路径与配置目录', () => {
    const result = mobileAgentsFromSettings(APP_SETTINGS)
    expect(result).toEqual({
      defaultAgent: 'claude',
      globalAccessMode: 'auto',
      agents: {
        local: { codex: { enabled: true }, claude: { enabled: true }, pi: { enabled: false } },
        'ssh-93': { claude: { enabled: false } },
      },
    })
    const text = JSON.stringify(result)
    expect(text).not.toContain('path')
    expect(text).not.toContain('configDir')
    expect(text).not.toContain('codex.exe')
    expect(mobileAgentsFromSettings(null)).toEqual({ defaultAgent: 'codex', agents: {} })
    expect(mobileAgentsFromSettings({ general: { defaultAgent: 'gpt' }, agents: [] })).toEqual({
      defaultAgent: 'codex',
      agents: {},
    })
    const polluted = JSON.parse('{"agents":{"__proto__":{"codex":{"enabled":false}}}}') as unknown
    expect(Object.keys(mobileAgentsFromSettings(polluted).agents)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).codex).toBeUndefined()
  })

  it('mobile.agents 下发隐藏模型名单，坏数据丢弃', () => {
    const result = mobileAgentsFromSettings({ general: { hiddenModels: { claude: ['default', 1], gpt: ['x'] } }, agents: {} })
    expect(result.hiddenModels).toEqual({ claude: ['default'] })
    expect('hiddenModels' in mobileAgentsFromSettings({ general: { hiddenModels: { claude: [] } } })).toBe(false)
  })

  it('codex.open 以电脑设置指定可执行文件和配置目录', () => {
    expect(injectAgentPath({ targetId: 'local', method: 'codex.open', params: { agent: 'codex' } }, APP_SETTINGS))
      .toEqual({ targetId: 'local', method: 'codex.open', params: {
        agent: 'codex', codexPath: 'C:\\tools\\codex.exe', codexHome: 'C:\\Users\\me\\.codex',
      } })
    expect(injectAgentPath({ targetId: 'local', method: 'codex.open', params: { agent: 'claude' } }, APP_SETTINGS))
      .toEqual({
        targetId: 'local',
        method: 'codex.open',
        params: { agent: 'claude', claudePath: 'C:\\Users\\me\\.local\\bin\\claude.exe', claudeConfigDir: 'D:\\claude-cfg' },
      })
    // 缺省 agent 视为 codex；手机自带的路径被丢弃并以设置为准。
    expect(injectAgentPath(
      { targetId: 'local', method: 'codex.open', params: {
        codexPath: '/tmp/evil', claudePath: '/tmp/x', codexHome: '/tmp/arbitrary', claudeConfigDir: '/tmp/other',
      } },
      APP_SETTINGS,
    )).toEqual({ targetId: 'local', method: 'codex.open', params: {
      codexPath: 'C:\\tools\\codex.exe', codexHome: 'C:\\Users\\me\\.codex',
    } })
    // 设置里路径为空或没有该目标：不补路径，由 server 自动解析；手机路径同样丢弃。
    expect(injectAgentPath(
      { targetId: 'local', method: 'codex.open', params: { agent: 'pi', piPath: '/tmp/pi' } },
      APP_SETTINGS,
    )).toEqual({ targetId: 'local', method: 'codex.open', params: { agent: 'pi' } })
    expect(injectAgentPath({ targetId: 'ssh-93', method: 'codex.open', params: { agent: 'claude' } }, APP_SETTINGS))
      .toEqual({ targetId: 'ssh-93', method: 'codex.open', params: { agent: 'claude' } })
    expect(injectAgentPath({ targetId: 'local', method: 'codex.open' }, null))
      .toEqual({ targetId: 'local', method: 'codex.open', params: {} })
    // 其他方法原样透传。
    const attach = { targetId: 'local', method: 'codex.attach', params: { agent: 'claude', sinceSeq: 3 } }
    expect(injectAgentPath(attach, APP_SETTINGS)).toBe(attach)
  })

  it('只转发手机可见事件，主机指纹确认不泄漏 promptId', () => {
    expect(mobileEventFromRouter('codex.recv', { targetId: 'local', agent: 'claude' }))
      .toEqual({ name: 'codex.recv', payload: { targetId: 'local', agent: 'claude' } })
    expect(mobileEventFromRouter('codex.recv', { targetId: 'local', seq: null, msg: { id: 'c1', result: {} } }))
      .toBeNull()
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

  it('拦截桌面终端事件并保留其他服务端事件', () => {
    for (const name of ['term.data', 'term.exit', 'term.resized', 'term.error']) {
      expect(mobileEventFromRouter('server.evt', { targetId: 'local', name, payload: {} })).toBeNull()
    }
    const payload = { targetId: 'local', name: 'fs.changed', payload: { path: '/project/file' } }
    expect(mobileEventFromRouter('server.evt', payload)).toEqual({ name: 'server.evt', payload })
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

    // 电脑端隐藏的项目不下发给手机。
    const projects = await requestJson('/rpc', 'POST', { method: 'projects.list', params: { targetId: 'local' } }, token)
    expect(projects.status).toBe(200)
    expect((projects.json() as { id: string }[]).map(({ id }) => id)).toEqual(['test-project'])

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

    const turn = await requestJson('/rpc', 'POST', {
      method: 'codex.send',
      params: { targetId: 'local', msg: { id: 'c1', method: 'turn/start', params: {
        threadId: 'thread', input: [], claudePermissionMode: 'bypassPermissions',
        qingcodeAccessOverride: true, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
      } } },
    }, token)
    expect(turn.status).toBe(200)
    expect(lastCodexSend).toEqual({ targetId: 'local', msg: {
      id: expect.any(String), method: 'turn/start', params: {
        threadId: 'thread', input: [], approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, qingcodeAccessOverride: true,
      },
    } })
    const forwarded = lastCodexSend
    agentSettingsAvailable = false
    try {
      const rejected = await requestJson('/rpc', 'POST', { method: 'codex.send', params: {
        targetId: 'local', agent: 'claude', msg: { id: 'settings-down', method: 'turn/start', params: { threadId: 'thread', input: [] } },
      } }, token)
      expect(rejected.json()).toMatchObject({ error: { code: 'access_settings_unavailable' } })
      expect(lastCodexSend).toBe(forwarded)
    } finally {
      agentSettingsAvailable = true
    }

    for (const [targetId, agent, supported] of [
      ['local', 'codex', true], ['local', 'claude', true], ['local', 'pi', false], ['ssh-93', 'codex', false],
    ] as const) {
      const attached = await requestJson('/rpc', 'POST', { method: 'server.req', params: {
        targetId, method: 'codex.attach', params: { agent, sinceSeq: 4 },
      } }, token)
      expect(attached.status).toBe(200)
      if (supported) expect(attached.json()).toHaveProperty('mobileAccessModes', true)
      else expect(attached.json()).not.toHaveProperty('mobileAccessModes')
    }
    const openedWithAccessModes = await requestJson('/rpc', 'POST', { method: 'server.req', params: {
      targetId: 'ssh-93', method: 'codex.open', params: { agent: 'codex' },
    } }, token)
    expect(openedWithAccessModes.json()).toHaveProperty('mobileAccessModes', true)

    const turnRequest = (agent: string, accessMode: string) => ({
      method: 'mobile.turn.start',
      params: { targetId: 'local', agent, accessMode, msg: { id: 'c2', method: 'turn/start', params: {
        threadId: 'thread', input: [], model: 'test-model', clientUserMessageId: 'mobile-user', claudePermissionMode: 'bypassPermissions',
        approvalPolicy: 'on-request', sandboxPolicy: { type: 'dangerFullAccess' },
      } } },
    })
    const codexAuto = await requestJson('/rpc', 'POST', turnRequest('codex', 'auto'), token)
    expect(codexAuto.status).toBe(200)
    expect(lastCodexSend).toEqual({ targetId: 'local', agent: 'codex', msg: {
      id: expect.any(String), method: 'turn/start', params: {
        threadId: 'thread', input: [], model: 'test-model', clientUserMessageId: 'mobile-user',
        approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, qingcodeAccessOverride: true,
      },
    } })
    const claudeTurn = await requestJson('/rpc', 'POST', turnRequest('claude', 'fullAccess'), token)
    expect(claudeTurn.status).toBe(200)
    expect(lastCodexSend).toEqual({ targetId: 'local', agent: 'claude', msg: {
      id: expect.any(String), method: 'turn/start',
      params: { threadId: 'thread', input: [], model: 'test-model', clientUserMessageId: 'mobile-user', claudePermissionMode: 'bypassPermissions' },
    } })
    const claudeAuto = await requestJson('/rpc', 'POST', turnRequest('claude', 'auto'), token)
    expect(claudeAuto.status).toBe(200)
    expect(lastCodexSend).toEqual({ targetId: 'local', agent: 'claude', msg: {
      id: expect.any(String), method: 'turn/start',
      params: { threadId: 'thread', input: [], model: 'test-model', clientUserMessageId: 'mobile-user', claudePermissionMode: 'auto' },
    } })
    // 计划模式只对声明了该能力的 Agent 生效（不支持的在下面的拒绝清单里）。
    expect((await requestJson('/rpc', 'POST', turnRequest('claude', 'plan'), token)).status).toBe(200)
    expect(lastCodexSend).toMatchObject({ msg: { params: { claudePermissionMode: 'plan' } } })
    const rewind = await requestJson('/rpc', 'POST', { method: 'codex.send', params: {
      targetId: 'local', agent: 'claude', msg: { id: 'rw', method: 'qingcode/files/rewind', params: { threadId: 'thread', turnId: 't', dryRun: false } },
    } }, token)
    expect(rewind.status).toBe(403)
    const forwardedTurn = lastCodexSend
    const inheritedTurn = (agent: string, mode: string) => {
      const request = turnRequest(agent, mode)
      return { ...request, params: { ...request.params, inheritAccess: true } }
    }
    const staleAccess = await requestJson('/rpc', 'POST', inheritedTurn('codex', 'default'), token)
    expect(staleAccess.status).toBe(409)
    expect(lastCodexSend).toBe(forwardedTurn)
    for (const [agent, mode] of [['pi', 'fullAccess'], ['codex', 'plan'], ['codex', 'readOnly'], ['codex', 'invalid']] as const) {
      const rejected = await requestJson('/rpc', 'POST', turnRequest(agent, mode), token)
      expect(rejected.status).toBe(400)
      expect(lastCodexSend).toBe(forwardedTurn)
    }
    expect((await requestJson('/rpc', 'POST', inheritedTurn('codex', 'auto'), token)).status).toBe(200)
    expect(lastCodexSend).toMatchObject({ msg: { params: { approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } } } })
    expect((await requestJson('/rpc', 'POST', inheritedTurn('claude', 'auto'), token)).status).toBe(200)
    expect(lastCodexSend).toMatchObject({ msg: { params: { claudePermissionMode: 'auto' } } })
    const defaultTurn = turnRequest('codex', 'default')
    expect((await requestJson('/rpc', 'POST', {
      ...defaultTurn, params: { ...defaultTurn.params, inheritAccess: false },
    }, token)).status).toBe(200)
    expect(lastCodexSend).toEqual({ targetId: 'local', agent: 'codex', msg: {
      id: expect.any(String), method: 'turn/start', params: {
        threadId: 'thread', input: [], model: 'test-model', clientUserMessageId: 'mobile-user',
      },
    } })

    const agents = await requestJson('/rpc', 'POST', { method: 'mobile.agents', params: {} }, token)
    expect(agents.status).toBe(200)
    expect(agents.json()).toEqual({ ...mobileAgentsFromSettings(APP_SETTINGS), fastHistoryOpen: true, backgroundQueue: true })
    expect(agents.text).not.toContain('claude.exe')

    const claudeOpened = await requestJson(
      '/rpc',
      'POST',
      {
        method: 'server.req',
        params: { targetId: 'local', method: 'codex.open', params: {
          agent: 'claude', claudePath: '/tmp/evil', claudeConfigDir: '/tmp/arbitrary',
        } },
      },
      token
    )
    expect(claudeOpened.status).toBe(200)
    expect(lastServerReq).toEqual({
      targetId: 'local',
      method: 'codex.open',
      params: { agent: 'claude', claudePath: 'C:\\Users\\me\\.local\\bin\\claude.exe', claudeConfigDir: 'D:\\claude-cfg' },
    })

    const fileRead = await requestJson(
      '/rpc',
      'POST',
      { method: 'server.req', params: { targetId: 'local', method: 'fs.read', params: { path: 'C:\\a.txt' } } },
      token
    )
    expect(fileRead.status).toBe(200)
    const writeFile = await requestJson(
      '/rpc',
      'POST',
      { method: 'server.req', params: { targetId: 'local', method: 'fs.write', params: { path: 'C:\\a.txt', content: 'x' } } },
      token
    )
    expect(writeFile.status).toBe(403)
    expect(lastServerReq).toMatchObject({ method: 'fs.read' })

    const tooLarge = await requestJson('/pair', 'POST', {
      code: PAIR_CODE,
      deviceName: '手机',
      padding: 'x'.repeat(MAX_REQUEST_BYTES + 10),
    })
    expect(tooLarge.status).toBe(413)

    const stream = openEventStream(token)
    await stream.ready
    router.emit('server.evt', { targetId: 'local', name: 'term.data', payload: { termId: 't1', seq: 1, data: 'dGVzdA==' } })
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

  it('没有事件流时也能通过 HTTPS 确认该轮已提交', async () => {
    const { token } = await deviceStore.add({ name: '发送测试手机', ip: '127.0.0.1', now })
    const turn = { id: 'turn-1', status: 'inProgress' }
    handleCodexRequest = ({ targetId, agent, msg }) => {
      const { id } = msg as { id: string }
      router.emit('codex.recv', { targetId, agent, seq: null, msg: { id, result: { turn } } })
    }
    try {
      const result = await requestJson('/rpc', 'POST', { method: 'mobile.turn.start', params: {
        targetId: 'local', agent: 'codex', accessMode: 'auto', replyViaHttp: true,
        msg: { id: 'turn-request', method: 'turn/start', params: { threadId: 'thread', input: [] } },
      } }, token)
      expect(result.status).toBe(200)
      expect(result.json()).toEqual({ reply: { id: 'turn-request', result: { turn } } })
    } finally {
      handleCodexRequest = undefined
    }
  })

  it('一次 HTTPS 调用恢复会话并返回最近一页，沿用 Agent 给出的游标', async () => {
    const { token } = await deviceStore.add({ name: '历史测试手机', ip: '127.0.0.1', now })
    const params = { targetId: 'local', agent: 'codex', threadId: 'history-thread' }
    const calls: unknown[] = []
    handleCodexRequest = ({ targetId, agent, msg }) => {
      const request = msg as { id: string; method: string; params: unknown }
      calls.push({ targetId, agent, method: request.method, params: request.params })
      const result = request.method === 'thread/resume'
        ? { thread: { id: params.threadId, status: { type: 'idle' }, turns: [] }, turnsBackwardsCursor: 'newest' }
        : { data: [{ id: 'recent', items: [] }], nextCursor: 'older' }
      router.emit('codex.recv', { targetId, agent, seq: null, msg: { id: request.id, result } })
    }
    try {
      const body = { method: 'mobile.history.open', params: { ...params, method: 'turn/start', cwd: '/irrelevant' } }
      expect((await requestJson('/rpc', 'POST', body)).status).toBe(401)
      const result = await requestJson('/rpc', 'POST', body, token)
      expect(result.status).toBe(200)
      expect(result.json()).toMatchObject({ resumed: true,
        thread: { id: params.threadId, turns: [{ id: 'recent' }] }, earlier: { turns: 'older' },
      })
      expect(calls).toEqual([
        { targetId: 'local', agent: 'codex', method: 'thread/resume', params: { threadId: params.threadId, excludeTurns: true } },
        { targetId: 'local', agent: 'codex', method: 'thread/turns/list', params: {
          threadId: params.threadId, cursor: 'newest', limit: 8, sortDirection: 'desc', itemsView: 'full',
        } },
      ])
    } finally {
      handleCodexRequest = undefined
    }
  })

  it('长历史只到发起设备，同名请求、桌面请求与审批互不干扰', async () => {
    const a = await deviceStore.add({ name: '本人手机', ip: '127.0.0.1', now })
    const b = await deviceStore.add({ name: '备用手机', ip: '127.0.0.1', now })
    const receivedA: GatewayEvent[] = []
    const receivedB: GatewayEvent[] = []
    const desktopEvents: unknown[] = []
    const desktop: WirePort = {
      postMessage: (message) => desktopEvents.push(message),
      on: () => undefined,
      start: () => undefined,
      close: () => undefined,
    }
    router.attachPort(desktop)
    const openPhone = (token: string, received: GatewayEvent[]) => openEventStream(token, (event) => {
      if (event.name === 'codex.recv') received.push(event)
      return event.name === 'target.state'
    })
    const first = openPhone(a.token, receivedA)
    const second = openPhone(b.token, receivedB)
    const request = async (token: string, method: 'codex.send' | 'mobile.turn.start') => {
      const params = method === 'codex.send'
        ? { targetId: 'local', msg: { id: 'c1', method: 'thread/read' } }
        : { targetId: 'local', agent: 'codex', accessMode: 'auto', msg: {
          id: 'c1', method: 'turn/start', params: { threadId: 'thread', input: [] },
        } }
      expect((await requestJson('/rpc', 'POST', { method, params }, token)).status).toBe(200)
      return (lastCodexSend as { msg: { id: string } }).msg.id
    }
    const reply = (msg: unknown) => router.emit('codex.recv', { targetId: 'local', agent: 'codex', seq: null, msg })
    const received = (msg: unknown, seq: number | null = null) => ({
      name: 'codex.recv', payload: { targetId: 'local', agent: 'codex' as const, seq, msg },
    })
    try {
      await Promise.all([first.ready, second.ready])
      const mobileIdA = await request(a.token, 'codex.send')
      const mobileIdB = await request(b.token, 'mobile.turn.start')
      expect(new Set([mobileIdA, mobileIdB, 'c1']).size).toBe(3)
      const desktopRequest = { targetId: 'local', msg: { id: 'c1', method: 'thread/read' } }
      await router.invoke('codex.send', desktopRequest)
      expect(lastCodexSend).toEqual(desktopRequest)

      const desktopReply = { id: 'c1', result: { desktop: true } }
      const error = { code: -32000, message: '模拟错误' }
      const result = { history: 'x'.repeat(2 * MAX_REQUEST_BYTES) }
      const approval = { id: 17, method: 'item/commandExecution/requestApproval', params: {} }
      reply(desktopReply)
      reply({ id: mobileIdB, error })
      reply({ id: mobileIdA, result })
      router.emit('codex.recv', received(approval, 8).payload)
      router.emit('target.state', { id: 'local', state: 'ready' })
      await Promise.all([first.event, second.event])

      expect(receivedA).toEqual([received({ id: 'c1', result }), received(approval, 8)])
      expect(receivedB).toEqual([received({ id: 'c1', error }), received(approval, 8)])
      expect(desktopEvents).toEqual([
        { t: 'evt', ...received(desktopReply) },
        { t: 'evt', ...received(approval, 8) },
        { t: 'evt', name: 'target.state', payload: { id: 'local', state: 'ready' } },
      ])

      const oldId = await request(a.token, 'codex.send')
      gateway?.disconnectDevice(a.device.id)
      const afterReconnect: GatewayEvent[] = []
      const reconnected = openPhone(a.token, afterReconnect)
      try {
        await reconnected.ready
        const newId = await request(a.token, 'codex.send')
        reply({ id: oldId, result: { stale: true } })
        reply({ id: newId, result: { fresh: true } })
        router.emit('target.state', { id: 'local', state: 'ready' })
        await reconnected.event
        expect(afterReconnect).toEqual([received({ id: 'c1', result: { fresh: true } })])
      } finally {
        reconnected.close()
      }
    } finally {
      first.close()
      second.close()
    }
  }, 20_000)

  it('手机只收到自己接回的终端事件，其他设备不能接回同一终端', async () => {
    const owner = await deviceStore.add({ name: '本人手机', ip: '127.0.0.1', now })
    const watcher = await deviceStore.add({ name: '另一台手机', ip: '127.0.0.1', now })
    const project = { projectId: 'test-project', targetId: 'local' }
    const call = (method: string, params: unknown, token: string) => requestJson('/rpc', 'POST', { method, params }, token)
    expect((await call('mobile.term.open', project, owner.token)).status).toBe(403)
    gateway?.setTerminalEnabled(true)
    const interested = (event: GatewayEvent) => event.name === 'mobile.terminal' || event.name === 'target.state'
    const first = openEventStream(owner.token, interested)
    const second = openEventStream(watcher.token, interested)
    try {
      await Promise.all([first.ready, second.ready])
      const opened = await call('mobile.term.open', project, owner.token)
      expect(opened.status).toBe(200)
      const { termId } = opened.json() as { termId: string }
      expect((await call('mobile.term.attach', { ...project, termId }, watcher.token)).status).toBe(403)
      expect((await call('mobile.term.attach', { ...project, termId }, owner.token)).status).toBe(200)
      const data = { targetId: 'local', name: 'term.data', payload: { termId, seq: 1, data: 'YQ==' } }
      router.emit('server.evt', data)
      router.emit('target.state', { id: 'local', state: 'ready' })
      expect(await first.event).toEqual({ name: 'mobile.terminal', payload: { ...data, projectId: project.projectId } })
      expect((await second.event).name).toBe('target.state')
    } finally {
      first.close()
      second.close()
      gateway?.setTerminalEnabled(false)
    }
  }, 20_000)
})
