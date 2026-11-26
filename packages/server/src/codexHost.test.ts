import path from 'node:path'
import { encodeFrame, MAX_FRAME_BYTES, type ServerMessage } from '@qn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { agentConfigEnv, CodexHost, describeCodexExit, parseAgentConfigDir } from './codexHost'

const fakeCodex = JSON.stringify([process.execPath, '-e', `
  const readline = require('node:readline');
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (!id) return;
    if (method === 'initialize') return send({ id, result: { fakeHome: process.env.CODEX_HOME } });
    if (method === 'thread/resume' && params.historySize) {
      const history = '历史😀'.repeat(params.historySize);
      const bytes = Buffer.from(JSON.stringify({ id, result: { thread: { id: params.threadId, history } } }) + '\\n');
      const split = bytes.indexOf(Buffer.from('历')) + 1;
      return process.stdout.write(bytes.subarray(0, split), () => {
        setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
      });
    }
    if (method === 'thread/start') return send({ id, result: {
      thread: { id: 'thread' }, approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: false },
    } });
    if (method === 'turn/start' && params.hold) send({ method: 'turn/started', params: { threadId: 'thread' } });
    if (method === 'turn/start' && params.replyFirst) return send({ id, result: { turn: { id: 'reply-first', status: 'inProgress' } } });
    if (method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: params.turnId } } });
    send({ id, result: params });
  });
`])

function harness() {
  const messages: ServerMessage[] = []
  const host = new CodexHost({
    send: (_clientId, message) => {
      encodeFrame(message)
      messages.push(message)
    },
    broadcastRecv: () => {},
    broadcastEvt: () => {},
    log: () => {},
  })
  async function request(id: string, method: string, params: Record<string, unknown> = {}) {
    host.handleClientMessage(1, { id, method, params })
    return vi.waitFor(() => {
      const message = messages.find((frame) => frame.t === 'codex.recv' && (frame.msg as { id?: string }).id === id)
      expect(message).toBeDefined()
      return (message as { msg: unknown }).msg
    })
  }
  return { host, request, messages }
}

describe('codex 退出原因', () => {
  it('找不到命令时提示安装或指定路径', () => {
    expect(describeCodexExit(null, 'spawn codex ENOENT')).toContain('未找到 codex 命令')
  })
  it('其它启动失败与非零退出码都带上原因', () => {
    expect(describeCodexExit(null, 'spawn EACCES')).toBe('codex 启动失败: spawn EACCES')
    expect(describeCodexExit(1, null)).toBe('codex app-server 已退出（退出码 1）')
    expect(describeCodexExit(null, null)).toBe('codex app-server 已退出')
  })
})

describe('Codex 历史回包', () => {
  it('接收大于 1 MiB 的历史并保留跨 stdout 分块的 UTF-8 字符', async () => {
    const { host, request } = harness()
    try {
      await host.open({ codexPath: fakeCodex })
      const result = await request('history', 'thread/resume', { threadId: 'thread', historySize: 300_000 })
      expect(result).toMatchObject({ result: { thread: { id: 'thread' } } })
      const { history } = (result as { result: { thread: { history: string } } }).result.thread
      expect(history.length).toBe(1_200_000)
      expect(history.startsWith('历史😀')).toBe(true)
      expect(history.includes('\ufffd')).toBe(false)
    } finally {
      host.shutdown()
    }
  })

  it('历史超过协议帧时返回明确错误，后续请求仍可用', async () => {
    const { host, request } = harness()
    try {
      await host.open({ codexPath: fakeCodex })
      await expect(request('large', 'thread/resume', {
        threadId: 'thread', historySize: Math.ceil(MAX_FRAME_BYTES / 10),
      })).resolves.toMatchObject({ error: { message: '会话数据超过传输大小上限' } })
      await expect(request('next', 'thread/read', { threadId: 'thread' })).resolves.toHaveProperty('result.threadId', 'thread')
    } finally {
      host.shutdown()
    }
  })
})

describe('Codex 权限覆盖', () => {
  it('原样向 Codex 发送 v2 覆盖项，普通发送恢复原会话权限', async () => {
    const { host, request } = harness()
    try {
      await host.open({ codexPath: fakeCodex })
      const original = { threadId: 'thread', input: [] }
      const sandboxPolicy = { type: 'dangerFullAccess' }
      const fullAccess = { ...original, approvalPolicy: 'never', sandboxPolicy }
      const managed = { ...fullAccess, qingcodeAccessOverride: true }
      expect(await request('unloaded', 'turn/start', managed)).toHaveProperty('error.code', -32602)
      await request('thread', 'thread/start')
      expect(await request('original', 'turn/start', original)).toEqual({ id: 'original', result: original })
      expect(await request('full', 'turn/start', managed)).toEqual({ id: 'full', result: fullAccess })
      expect(await request('reset', 'turn/start', original)).toMatchObject({
        result: {
          ...original,
          approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: false },
        },
      })
    } finally {
      host.shutdown()
    }
  })
})

describe('Agent 配置目录', () => {
  it('只接受目标主机上的非空绝对路径', () => {
    expect(parseAgentConfigDir(undefined, 'CODEX_HOME')).toBeUndefined()
    expect(parseAgentConfigDir(' /tmp/my config ', 'CODEX_HOME', 'linux')).toBe('/tmp/my config')
    expect(parseAgentConfigDir('C:\\Work\\config', 'CLAUDE_CONFIG_DIR', 'win32')).toBe('C:\\Work\\config')
    expect(parseAgentConfigDir('\\\\server\\share\\config', 'CODEX_HOME', 'win32')).toBe('\\\\server\\share\\config')
    expect(() => parseAgentConfigDir('C:relative', 'CODEX_HOME', 'win32')).toThrow('绝对路径')
    expect(() => parseAgentConfigDir('\\relative', 'CODEX_HOME', 'win32')).toThrow('绝对路径')
    for (const bad of ['', '  ', '~/config', '/tmp/\0', 12, null]) {
      expect(() => parseAgentConfigDir(bad, 'CODEX_HOME', 'linux')).toThrow('绝对路径')
    }
  })

  it('环境覆盖只影响指定 Agent 子进程的配置变量', () => {
    const original = { Path: 'path', Codex_Home: 'old', CLAUDE_CONFIG_DIR: 'elsewhere' }
    expect(agentConfigEnv(original, 'CODEX_HOME', 'new', 'win32')).toEqual({
      Path: 'path', CODEX_HOME: 'new', CLAUDE_CONFIG_DIR: 'elsewhere',
    })
    expect(agentConfigEnv(original, 'CODEX_HOME', undefined, 'win32')).toEqual(original)
    expect(original.Codex_Home).toBe('old')
  })

  it('同目录继续复用，活动轮次拒绝切换，结束后可重启和清空覆盖', async () => {
    const { host, request, messages } = harness()
    const inherited = path.resolve('inherited-config')
    const previous = path.resolve('previous-config')
    const requested = path.resolve('requested-config')
    vi.stubEnv('CODEX_HOME', inherited)
    try {
      expect((await host.open({ codexPath: fakeCodex, codexHome: previous })).initialize).toEqual({ fakeHome: previous })
      const firstPid = host.status().pid
      await host.open({ codexHome: previous })
      expect(host.status().pid).toBe(firstPid)
      await request('run', 'turn/start', { threadId: 'thread', input: [], hold: true })
      expect(host.activeTurns).toBe(1)
      await expect(host.open({ codexPath: fakeCodex, codexHome: requested })).rejects.toMatchObject({ code: 'config_dir_busy' })
      expect(host.status().pid).toBe(firstPid)
      await request('stop', 'turn/interrupt')
      await request('early-reply', 'turn/start', { threadId: 'thread', input: [], replyFirst: true })
      expect(host.activeTurns).toBe(0)
      await expect(host.open({ codexPath: fakeCodex, codexHome: requested })).rejects.toMatchObject({ code: 'config_dir_busy' })
      await request('stop-early-reply', 'turn/interrupt', { turnId: 'reply-first' })
      const priorSeq = host.lastSeq
      expect(priorSeq).toBeGreaterThan(0)
      expect((await host.open({ codexPath: fakeCodex, codexHome: requested })).initialize).toEqual({ fakeHome: requested })
      expect(host.status().pid).not.toBe(firstPid)
      messages.length = 0
      expect(host.attach(1, 0).lastSeq).toBe(priorSeq)
      expect(messages).toEqual([])
      expect((await host.open({ codexPath: fakeCodex })).initialize).toEqual({ fakeHome: inherited })
      expect(process.env.CODEX_HOME).toBe(inherited)
    } finally {
      host.shutdown()
      vi.unstubAllEnvs()
    }
  })
})
