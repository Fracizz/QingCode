import { LOCAL_TARGET } from '../shared/backendApi'
import { describe, expect, it, vi } from 'vitest'
import { RouterError } from './router'
import { TargetManager, retryDelay } from './targets'
import type { LinkHooks, LocalLinkContext, SshLinkContext, TargetLink } from './types'

vi.mock('./sshTarget', () => ({ connectSshTarget: vi.fn(), runRemoteServerCommands: vi.fn(), testSshTarget: vi.fn() }))

class FakeLink implements TargetLink {
  readonly requests: Array<{ method: string; params?: unknown }> = []
  readonly sent: unknown[] = []
  closed = false

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    return { method, params }
  }

  codexSend(msg: unknown): void {
    this.sent.push(msg)
  }

  close(): void {
    this.closed = true
  }
}

interface Harness {
  manager: TargetManager
  links: FakeLink[]
  hooks: LinkHooks[]
  emitted: Array<{ name: string; payload: unknown }>
  responded: Array<[string, boolean]>
}

function harness(): Harness {
  const links: FakeLink[] = []
  const hooks: LinkHooks[] = []
  const emitted: Array<{ name: string; payload: unknown }> = []
  const responded: Array<[string, boolean]> = []
  const local = async (ctx: LocalLinkContext): Promise<TargetLink> => {
    hooks.push(ctx.hooks)
    const link = new FakeLink()
    links.push(link)
    return link
  }
  const ssh = async (ctx: SshLinkContext): Promise<TargetLink> => {
    hooks.push(ctx.hooks)
    const link = new FakeLink()
    links.push(link)
    return link
  }
  const manager = new TargetManager({
    userData: '',
    resourcesPath: '',
    electronPath: '',
    appVersion: '9.9.9',
    emit: (name, payload) => emitted.push({ name, payload }),
    createLocal: local,
    createSsh: ssh,
    gate: {
      verify: async () => true,
      respond: (promptId, accept) => {
        responded.push([promptId, accept])
        return true
      },
      close: () => {},
    },
  })
  return { manager, links, hooks, emitted, responded }
}

describe('retryDelay', () => {
  it('1s 起指数退避并封顶 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('TargetManager', () => {
  it('连接本机、透传 req/codex.send、给事件加 targetId、断开后不重连', async () => {
    const { manager, links, hooks, emitted } = harness()
    await manager.connect(LOCAL_TARGET, {})
    expect(manager.getState('local')).toBe('ready')
    await manager.waitUntilReady('local', 100)
    const link = links[0]
    expect(link).toBeDefined()
    expect(await manager.request('local', 'ping')).toEqual({ method: 'ping', params: undefined })
    manager.codexSend('local', { id: 1, method: 'thread/list' })
    expect(link?.requests).toEqual([{ method: 'ping', params: undefined }])
    expect(link?.sent).toEqual([{ id: 1, method: 'thread/list' }])

    hooks[0]?.onEvent('codex.exited', { code: 1 })
    hooks[0]?.onCodexRecv(5, { method: 'turn/started' }, 'codex')
    expect(emitted).toContainEqual({
      name: 'server.evt',
      payload: { targetId: 'local', name: 'codex.exited', payload: { code: 1 } },
    })
    expect(emitted).toContainEqual({
      name: 'codex.recv',
      payload: { targetId: 'local', agent: 'codex', seq: 5, msg: { method: 'turn/started' } },
    })
    expect(emitted).toContainEqual({ name: 'target.state', payload: { id: 'local', state: 'ready' } })

    manager.disconnect('local')
    expect(manager.getState('local')).toBe('idle')
    expect(link?.closed).toBe(true)
    expect(links).toHaveLength(1)
    manager.shutdown()
  })

  it('codex.open 过的目标重连后自动 codex.attach{sinceSeq:lastSeq}', async () => {
    vi.useFakeTimers()
    const { manager, links, hooks, emitted } = harness()
    try {
      await manager.connect(LOCAL_TARGET, {})
      await manager.request('local', 'codex.open', {})
      hooks[0]?.onCodexRecv(7, { method: 'turn/completed' }, 'codex')
      hooks[0]?.onClose(new Error('连接中断'))
      expect(manager.getState('local')).toBe('error')
      expect(emitted.some((e) => e.name === 'target.state' &&
        (e.payload as { detail?: string }).detail === '连接中断')).toBe(true)

      await vi.advanceTimersByTimeAsync(1000)
      expect(links).toHaveLength(2)
      expect(links[1]?.requests[0]).toEqual({ method: 'codex.attach', params: { sinceSeq: 7 } })
      expect(manager.getState('local')).toBe('ready')
      expect(emitted).toContainEqual({
        name: 'target.state',
        payload: { id: 'local', state: 'connecting', detail: '重新连接（第 1 次）' },
      })
    } finally {
      manager.shutdown()
      vi.useRealTimers()
    }
  })

  it('未 open 过 codex 的目标重连不 attach；disconnect 会取消退避', async () => {
    vi.useFakeTimers()
    const { manager, links, hooks } = harness()
    try {
      await manager.connect(LOCAL_TARGET, {})
      hooks[0]?.onClose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(links).toHaveLength(2)
      expect(links[1]?.requests).toEqual([])

      hooks[1]?.onClose()
      manager.disconnect('local')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(links).toHaveLength(2)
      expect(manager.getState('local')).toBe('idle')
    } finally {
      manager.shutdown()
      vi.useRealTimers()
    }
  })

  it('未连接时请求报 not_connected，hostKey.respond 转给 gate', async () => {
    const { manager, responded } = harness()
    await expect(manager.request('missing', 'ping')).rejects.toMatchObject({ code: 'not_connected' })
    expect(() => manager.codexSend('missing', null)).toThrow(RouterError)
    manager.respondHostKey('p1', true)
    expect(responded).toEqual([['p1', true]])
    manager.shutdown()
  })

  it('首次连接失败停在 error，不自动重试（避免拒绝主机指纹后反复弹窗）', async () => {
    vi.useFakeTimers()
    const links: FakeLink[] = []
    const emitted: Array<{ name: string; payload: unknown }> = []
    const manager = new TargetManager({
      userData: '',
      resourcesPath: '',
      electronPath: '',
      appVersion: '',
      emit: (name, payload) => emitted.push({ name, payload }),
      createLocal: async () => {
        throw new Error('本机 daemon 未就绪')
      },
    })
    try {
      await manager.connect(LOCAL_TARGET, {})
      expect(manager.getState('local')).toBe('error')
      expect(emitted.some((e) => e.name === 'target.state' &&
        (e.payload as { detail?: string }).detail === '本机 daemon 未就绪')).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(links).toHaveLength(0)
    } finally {
      manager.shutdown()
      vi.useRealTimers()
    }
  })

  it('已建立连接断开后，重试失败仍按退避继续重试', async () => {
    vi.useFakeTimers()
    const links: FakeLink[] = []
    const hooks: LinkHooks[] = []
    let attempts = 0
    const manager = new TargetManager({
      userData: '',
      resourcesPath: '',
      electronPath: '',
      appVersion: '',
      emit: () => {},
      createLocal: async (ctx) => {
        attempts++
        // 第二次（第一次重连）模拟远端仍不可用，第三次恢复。
        if (attempts === 2) throw new Error('远端暂不可用')
        hooks.push(ctx.hooks)
        const link = new FakeLink()
        links.push(link)
        return link
      },
    })
    try {
      await manager.connect(LOCAL_TARGET, {})
      expect(manager.getState('local')).toBe('ready')
      hooks[0]?.onClose(new Error('连接中断'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(manager.getState('local')).toBe('error')
      await vi.advanceTimersByTimeAsync(2000)
      expect(links).toHaveLength(2)
      expect(manager.getState('local')).toBe('ready')
    } finally {
      manager.shutdown()
      vi.useRealTimers()
    }
  })
})

describe('TargetManager.test', () => {
  const target = { id: 'ssh-1', kind: 'ssh' as const, name: 'w', host: 'h', port: 22, username: 'u', auth: { kind: 'password' as const } }

  it('已保存的凭据打底，表单里新填的覆盖它，且不建立会话', async () => {
    const seen: unknown[] = []
    const manager = new TargetManager({
      userData: '',
      resourcesPath: '',
      electronPath: '',
      appVersion: '1',
      emit: () => {},
      loadSecret: async () => ({ password: 'saved' }),
      testSsh: async (context) => {
        seen.push(context.credentials)
        return { os: 'Windows', nodeVersion: 'v24.0.0' }
      },
    })
    await manager.test(target, {})
    await manager.test(target, { password: 'typed' })
    // 尚未保存的新连接没有 id，不能读到别的目标的凭据。
    await manager.test({ ...target, id: '' }, {})
    expect(seen).toEqual([{ password: 'saved' }, { password: 'typed' }, {}])
    expect(manager.getState('ssh-1')).toBe('idle')
    manager.shutdown()
  })
})

describe('TargetManager 直连加速', () => {
  const direct = { host: '10.0.0.5', port: 47390, fingerprint: 'f'.repeat(64), grantId: 'g1' }
  const target = {
    id: 'ssh-d',
    kind: 'ssh' as const,
    name: 'w',
    host: 'h',
    port: 22,
    username: 'u',
    auth: { kind: 'password' as const },
    direct,
  }

  function make(directOk: boolean, saved: Record<string, string>, sshOk = true) {
    const used: string[] = []
    const directSeen: unknown[] = []
    const verify = vi.fn(async () => true)
    const emit = vi.fn()
    const manager = new TargetManager({
      userData: '',
      resourcesPath: '',
      electronPath: '',
      appVersion: '1',
      emit,
      loadSecret: async () => saved,
      createDirect: async (ctx) => {
        directSeen.push({ host: ctx.target.host, port: ctx.target.port, token: ctx.token, timeout: ctx.connectTimeoutMs })
        if (!directOk) throw new Error('ECONNREFUSED')
        used.push('direct')
        return new FakeLink()
      },
      createSsh: async ({ gate }) => {
        used.push('ssh')
        await gate.verify(target.host, target.port, 'SHA256:known')
        if (!sshOk) throw new Error('SSH 不可用')
        return new FakeLink()
      },
      gate: { verify, respond: () => true, close: () => {} },
    })
    return { manager, used, directSeen, verify, emit }
  }

  it('有直连配置和 token 时先走直连', async () => {
    const { manager, used, directSeen } = make(true, { directToken: 't'.repeat(64) })
    await manager.connect(target, {})
    expect(used).toEqual(['direct'])
    expect(directSeen).toEqual([{ host: '10.0.0.5', port: 47390, token: 't'.repeat(64), timeout: 5000 }])
    expect(manager.getState('ssh-d')).toBe('ready')
    manager.shutdown()
  })

  it('直连失败回退 SSH', async () => {
    const { manager, used } = make(false, { directToken: 't'.repeat(64) })
    await manager.connect(target, {})
    expect(used).toEqual(['ssh'])
    expect(manager.getState('ssh-d')).toBe('ready')
    manager.shutdown()
  })

  it('没有 token 时不试直连', async () => {
    const { manager, used, directSeen } = make(true, {})
    await manager.connect(target, {})
    expect(directSeen).toEqual([])
    expect(used).toEqual(['ssh'])
    manager.shutdown()
  })

  it('启动时经 SSH 部署，指纹验证使用后台模式', async () => {
    const { manager, used, verify } = make(true, { directToken: 'token' })
    await manager.connect(target, {}, false, true)
    expect(used).toEqual(['ssh'])
    expect(verify).toHaveBeenCalledWith(target.host, target.port, 'SHA256:known', false)
    expect(manager.getState(target.id)).toBe('ready')
    manager.shutdown()
  })

  it('启动时 SSH 更新失败后用已有直连，并显示更新结果', async () => {
    const { manager, used, emit } = make(true, { directToken: 'token' }, false)
    await manager.connect(target, {}, false, true)
    expect(used).toEqual(['ssh', 'direct'])
    expect(await manager.request(target.id, 'ping')).toEqual({ method: 'ping', params: undefined })
    expect(emit).toHaveBeenCalledWith('target.state', {
      id: target.id, state: 'ready', detail: 'SSH 更新未完成（SSH 不可用），已通过直连连接',
    })
    manager.shutdown()
  })

  it('SSH 部署超时后本机仍可用，手动重试成功后忽略迟到的结果', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const staleLink = new FakeLink()
    const liveLink = new FakeLink()
    let finish!: (link: TargetLink) => void
    const pending = new Promise<TargetLink>((resolve) => { finish = resolve })
    const createSsh = vi.fn<(ctx: SshLinkContext) => Promise<TargetLink>>()
      .mockImplementationOnce(({ hooks }) => {
        hooks.onState('deploying', '正在上传 server')
        return pending
      })
      .mockResolvedValueOnce(liveLink)
    const manager = new TargetManager({
      userData: '', resourcesPath: '', electronPath: '', appVersion: '1', emit, createSsh,
      loadSecret: async () => ({ password: 'saved' }),
      createLocal: async () => new FakeLink(),
    })
    const sshTarget = { ...target, direct: undefined }
    try {
      const startup = manager.connect(sshTarget, {}, false, true)
      await vi.advanceTimersByTimeAsync(0)
      const context = createSsh.mock.calls[0]?.[0]
      expect(context?.credentials).toEqual({ password: 'saved' })
      expect(manager.getState(target.id)).toBe('deploying')
      await manager.connect(LOCAL_TARGET, {})
      expect(manager.getState('local')).toBe('ready')

      await vi.advanceTimersByTimeAsync(60_000)
      await startup
      expect(context?.signal?.aborted).toBe(true)
      expect(emit).toHaveBeenLastCalledWith('target.state', {
        id: target.id, state: 'error', detail: expect.stringContaining('超时'),
      })

      await manager.connect(sshTarget, {})
      finish(staleLink)
      context?.hooks.onState('deploying', '迟到的进度')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(staleLink.closed).toBe(true)
      expect(liveLink.closed).toBe(false)
      expect(manager.getState(target.id)).toBe('ready')
      expect(createSsh).toHaveBeenCalledTimes(2)
    } finally {
      manager.shutdown()
      vi.useRealTimers()
    }
  })

  it('读取启动凭据期间手动断开，迟到的数据不会恢复连接', async () => {
    let finish!: (credentials: { password: string }) => void
    const pending = new Promise<{ password: string }>((resolve) => { finish = resolve })
    const createSsh = vi.fn(async () => new FakeLink())
    const manager = new TargetManager({
      userData: '', resourcesPath: '', electronPath: '', appVersion: '1', emit: vi.fn(),
      loadSecret: () => pending,
      createSsh,
    })
    const startup = manager.connect(target, {}, false, true)
    manager.disconnect(target.id)
    await startup
    finish({ password: 'saved' })
    await pending
    expect(createSsh).not.toHaveBeenCalled()
    expect(manager.getState(target.id)).toBe('idle')
    manager.shutdown()
  })

  it('remoteServer 合并已保存凭据，setDirectToken 只改 directToken', async () => {
    const saved: Record<string, string> = { password: 'p' }
    const runs: unknown[] = []
    const manager = new TargetManager({
      userData: '',
      resourcesPath: '/res',
      electronPath: '',
      appVersion: '1',
      emit: () => {},
      loadSecret: async () => ({ ...saved }),
      saveSecret: async (_id, creds) => {
        for (const key of Object.keys(saved)) delete saved[key]
        Object.assign(saved, creds)
      },
      runRemote: async (ctx, commands) => {
        runs.push({ creds: ctx.credentials, res: ctx.resourcesPath, commands })
        return [{ ok: true }]
      },
      gate: { verify: async () => true, respond: () => true, close: () => {} },
    })
    expect(await manager.remoteServer(target, { passphrase: 'x' }, [['direct', 'status']])).toEqual([{ ok: true }])
    expect(runs).toEqual([{ creds: { password: 'p', passphrase: 'x' }, res: '/res', commands: [['direct', 'status']] }])
    await manager.setDirectToken('ssh-d', 'tok')
    expect(saved).toEqual({ password: 'p', directToken: 'tok' })
    await manager.setDirectToken('ssh-d', undefined)
    expect(saved).toEqual({ password: 'p' })
    manager.shutdown()
  })
})
