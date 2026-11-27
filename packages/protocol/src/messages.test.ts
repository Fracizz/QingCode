import { describe, expect, it } from 'vitest'
import {
  isAgentKind,
  parseAgent,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type ServerMethods,
} from './index'

describe('parseClientMessage', () => {
  it('接受 hello / req / codex.send 的正例', () => {
    const hello = {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      token: 'deadbeef',
      client: { name: 'qingcode-next', version: '0.0.1' },
    }
    expect(parseClientMessage(hello)).toEqual(hello)

    const req = { t: 'req', id: 7, method: 'fs.list', params: { path: '/home', dirsOnly: true } }
    expect(parseClientMessage(req)).toEqual(req)
    expect(parseClientMessage({ t: 'req', id: 8, method: 'ping' })).toEqual({
      t: 'req',
      id: 8,
      method: 'ping',
    })

    const send = {
      t: 'codex.send',
      msg: { jsonrpc: '2.0', id: 'c1', method: 'thread/start', params: { cwd: '/tmp' } },
    }
    expect(parseClientMessage(send)).toEqual(send)
    expect(parseClientMessage({ ...send, agent: 'claude' })).toEqual({
      ...send,
      agent: 'claude',
    })
    expect(parseClientMessage({ ...send, agent: 'codex' })).toBeTruthy()
  })

  it('保留扩展字段以便向后兼容', () => {
    const req = { t: 'req', id: 1, method: 'ping', traceId: 'abc' }
    expect(parseClientMessage(req)).toBe(req)
  })

  it('拒绝结构不合法的消息', () => {
    const base = { t: 'hello', protocol: PROTOCOL_VERSION, token: 'x', client: { name: 'n', version: 'v' } }
    const invalid: unknown[] = [
      null,
      undefined,
      'hello',
      1,
      [],
      {},
      { t: 'unknown' },
      { t: 'welcome', protocol: 1, serverVersion: 'v', pid: 1 },
      { ...base, protocol: 2 },
      { ...base, protocol: '1' },
      { ...base, token: 1 },
      { ...base, client: null },
      { ...base, client: { name: 'n' } },
      { ...base, client: { name: 1, version: 'v' } },
      { t: 'req', method: 'ping' },
      { t: 'req', id: '1', method: 'ping' },
      { t: 'req', id: Number.NaN, method: 'ping' },
      { t: 'req', id: 1, method: 1 },
      { t: 'codex.send' },
      { t: 'codex.send', msg: null },
      { t: 'codex.send', msg: 'raw' },
      { t: 'codex.send', msg: [1] },
      { t: 'codex.send', msg: { method: 'x' }, agent: 'other' },
      { t: 'codex.send', msg: { method: 'x' }, agent: null },
      { t: 'codex.send', msg: { method: 'x' }, agent: 1 },
    ]
    for (const value of invalid) expect(parseClientMessage(value)).toBeNull()
  })
})

describe('parseServerMessage', () => {
  it('接受 welcome / res / evt / codex.recv / error 的正例', () => {
    const welcome = { t: 'welcome', protocol: PROTOCOL_VERSION, serverVersion: '0.0.1', pid: 123 }
    expect(parseServerMessage(welcome)).toEqual(welcome)

    const ok = { t: 'res', id: 1, ok: true, result: { path: '/root' } }
    expect(parseServerMessage(ok)).toEqual(ok)
    expect(parseServerMessage({ t: 'res', id: 2, ok: true, result: null })).toBeTruthy()

    const err = { t: 'res', id: 3, ok: false, error: { code: 'not_found', message: 'missing' } }
    expect(parseServerMessage(err)).toEqual(err)
    expect(
      parseServerMessage({ t: 'res', id: 4, ok: false, error: { code: -32000, message: 'boom' } }),
    ).toBeTruthy()

    const evt = { t: 'evt', name: 'codex.exited', payload: { code: 1, signal: null } }
    expect(parseServerMessage(evt)).toEqual(evt)
    expect(parseServerMessage({ t: 'evt', name: 'noop', payload: null })).toBeTruthy()

    const recv = { t: 'codex.recv', seq: 12, msg: { method: 'turn/started', params: {} } }
    expect(parseServerMessage(recv)).toEqual(recv)
    expect(parseServerMessage({ t: 'codex.recv', seq: null, msg: { id: 1, result: {} } })).toBeTruthy()
    expect(parseServerMessage({ t: 'codex.recv', seq: 0, msg: { method: 'x' } })).toBeTruthy()
    expect(
      parseServerMessage({ t: 'codex.recv', seq: 1, msg: { method: 'x' }, agent: 'claude' }),
    ).toEqual({ t: 'codex.recv', seq: 1, msg: { method: 'x' }, agent: 'claude' })

    const error = { t: 'error', code: 'auth', message: 'bad token' }
    expect(parseServerMessage(error)).toEqual(error)
    expect(parseServerMessage({ t: 'error', code: 'protocol', message: 'version' })).toBeTruthy()
  })

  it('拒绝结构不合法的消息', () => {
    const invalid: unknown[] = [
      null,
      undefined,
      42,
      'welcome',
      [],
      {},
      { t: 'req', id: 1, method: 'ping' },
      { t: 'hello', protocol: 1, token: 'x', client: { name: 'n', version: 'v' } },
      { t: 'welcome', protocol: 2, serverVersion: 'v', pid: 1 },
      { t: 'welcome', protocol: 1, serverVersion: 1, pid: 1 },
      { t: 'welcome', protocol: 1, serverVersion: 'v', pid: '1' },
      { t: 'res', ok: true, result: 1 },
      { t: 'res', id: 1, ok: 'true', result: 1 },
      { t: 'res', id: 1, ok: true },
      { t: 'res', id: 1, ok: false },
      { t: 'res', id: 1, ok: false, error: { code: 'x' } },
      { t: 'res', id: 1, ok: false, error: { code: 'x', message: 1 } },
      { t: 'evt', payload: 1 },
      { t: 'evt', name: 1, payload: null },
      { t: 'evt', name: 'x' },
      { t: 'codex.recv', seq: '1', msg: { method: 'x' } },
      { t: 'codex.recv', seq: 1 },
      { t: 'codex.recv', seq: 1, msg: null },
      { t: 'codex.recv', msg: { method: 'x' } },
      { t: 'codex.recv', seq: 1, msg: { method: 'x' }, agent: 'other' },
      { t: 'codex.recv', seq: 1, msg: { method: 'x' }, agent: null },
      { t: 'error' },
      { t: 'error', code: 'auth' },
      { t: 'error', code: {}, message: 'x' },
      { t: 'error', code: 'auth', message: 1 },
    ]
    for (const value of invalid) expect(parseServerMessage(value)).toBeNull()
  })

  it('两个方向的解析器互不越界', () => {
    const messages: unknown[] = [
      { t: 'hello', protocol: 1, token: 'x', client: { name: 'n', version: 'v' } },
      { t: 'req', id: 1, method: 'ping' },
      { t: 'codex.send', msg: { method: 'initialized' } },
      { t: 'welcome', protocol: 1, serverVersion: 'v', pid: 1 },
      { t: 'res', id: 1, ok: true, result: {} },
      { t: 'evt', name: 'x', payload: {} },
      { t: 'codex.recv', seq: 1, msg: { method: 'x' } },
      { t: 'error', code: 'auth', message: 'x' },
    ]
    for (const message of messages) {
      const client = parseClientMessage(message)
      const server = parseServerMessage(message)
      expect(client === null || server === null).toBe(true)
    }
  })
})

describe('agent 字段', () => {
  it('缺省等同 codex，显式值只允许 codex / claude', () => {
    expect(parseAgent(undefined)).toBe('codex')
    expect(parseAgent('codex')).toBe('codex')
    expect(parseAgent('claude')).toBe('claude')
    for (const bad of [null, '', 'other', 1, true, {}, ['claude']]) {
      expect(parseAgent(bad)).toBeNull()
      expect(isAgentKind(bad)).toBe(false)
    }
  })

  it('open / attach / status 的方法表带可选 agent，open 额外带 claudePath', () => {
    const open: ServerMethods['codex.open']['params'] = {
      agent: 'claude',
      claudePath: 'C:/claude.exe',
    }
    const attach: ServerMethods['codex.attach']['params'] = { sinceSeq: 3, agent: 'claude' }
    const status: ServerMethods['codex.status']['params'] = { agent: 'claude' }
    const result: ServerMethods['codex.open']['result'] = {
      initialize: { userAgent: 'claude-bridge/2.1.331' },
      lastSeq: 0,
      agentVersion: '2.1.331',
    }
    expect(open.agent).toBe('claude')
    expect(attach.sinceSeq).toBe(3)
    expect(status.agent).toBe('claude')
    expect(result.agentVersion).toBe('2.1.331')
  })
})

describe('消息与方法表类型', () => {
  it('方法表覆盖 mvp.md §4 的七个 req，且联合类型可用', () => {
    const methods: (keyof ServerMethods)[] = [
      'ping',
      'fs.home',
      'fs.list',
      'codex.open',
      'codex.attach',
      'codex.status',
      'server.shutdown',
    ]
    expect(methods).toHaveLength(7)

    const pingResult: ServerMethods['ping']['result'] = { serverVersion: '0.0.1', protocol: 1 }
    const listResult: ServerMethods['fs.list']['result'] = {
      path: '/root',
      entries: [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }],
    }
    const attachParams: ServerMethods['codex.attach']['params'] = { sinceSeq: 12 }
    expect(pingResult.protocol).toBe(1)
    expect(listResult.entries[0]?.kind).toBe('dir')
    expect(attachParams.sinceSeq).toBe(12)

    const client: ClientMessage = { t: 'req', id: 1, method: 'ping' }
    const server: ServerMessage = { t: 'res', id: 1, ok: true, result: pingResult }
    expect(client.t).toBe('req')
    expect(server.t).toBe('res')
  })
})
