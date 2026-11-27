import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeDirectCode } from '@qn/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { SavedSecret, SshTarget } from '../shared/backendApi'
import { backendConfig } from './config'
import { connectDirectTarget } from './directTarget'
import { registerTargetMethods } from './registerTargets'
import { BackendRouter, type WirePort } from './router'
import { loadSecret, saveSecret } from './secretStore'
import { connectSshTarget, runRemoteServerCommands } from './sshTarget'
import { readTargets, writeTargets } from './targetStore'

vi.mock('./sshTarget', () => ({ connectSshTarget: vi.fn(), runRemoteServerCommands: vi.fn(), testSshTarget: vi.fn() }))
vi.mock('./directTarget', () => ({ connectDirectTarget: vi.fn() }))
vi.mock('./secretStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('./secretStore')>(), loadSecret: vi.fn(), saveSecret: vi.fn(),
}))

class FakePort implements WirePort {
  readonly messages: unknown[] = []
  on(): void {}
  start(): void {}
  close(): void {}
  postMessage(message: unknown): void {
    this.messages.push(message)
  }
}

async function call(router: BackendRouter, port: FakePort, method: string, params?: unknown): Promise<unknown> {
  await router.handleMessage({ t: 'req', id: 1, method, params }, port)
  return port.messages[port.messages.length - 1]
}

describe('registerTargetMethods', () => {
  it('注册了 T5 的全部方法（不再返回 not_implemented）', async () => {
    const router = new BackendRouter()
    const port = new FakePort()
    registerTargetMethods(router)
    router.attachPort(port)

    expect(await call(router, port, 'target.disconnect', { id: 'unknown' })).toEqual({
      t: 'res', id: 1, ok: true, result: undefined,
    })
    expect(await call(router, port, 'server.req', { targetId: 'local', method: 'ping' })).toMatchObject({
      t: 'res', ok: false, error: { code: 'not_connected' },
    })
    expect(await call(router, port, 'codex.send', { targetId: 'local', msg: null })).toMatchObject({
      t: 'res', ok: false, error: { code: 'invalid_params' },
    })
  })

  it('参数校验与目标查找', async () => {
    const router = new BackendRouter()
    const port = new FakePort()
    registerTargetMethods(router)
    router.attachPort(port)

    expect(await call(router, port, 'server.req', {})).toMatchObject({
      ok: false, error: { code: 'invalid_params' },
    })
    expect(await call(router, port, 'hostKey.respond', { promptId: 'x' })).toMatchObject({
      ok: false, error: { code: 'invalid_params' },
    })
    expect(await call(router, port, 'target.connect', { id: 'no-such-target' })).toMatchObject({
      ok: false, error: { code: 'not_found' },
    })
    expect(await call(router, port, 'target.forceUpdate', { id: 'local' })).toMatchObject({
      ok: false, error: { code: 'not_connected' },
    })
  })

  it('启动标记传给远程连接，手动断开可取消正在读取的目标', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'qn-startup-target-'))
    const previousUserData = backendConfig.userData
    backendConfig.userData = userData
    const target: SshTarget = { id: 'remote', name: '远程', kind: 'ssh', host: 'host', port: 22, username: 'user', auth: { kind: 'agent' } }
    const ssh = vi.mocked(connectSshTarget)
    ssh.mockResolvedValue({ request: vi.fn(), codexSend: vi.fn(), close: vi.fn() })
    const router = new BackendRouter()
    registerTargetMethods(router)
    try {
      await writeTargets(userData, [target])
      const pending = router.invoke('target.connect', { id: target.id, startup: true })
      await router.invoke('target.disconnect', { id: target.id })
      await pending
      expect(ssh).not.toHaveBeenCalled()

      await router.invoke('target.connect', { id: target.id, startup: true })
      expect(ssh.mock.calls[0]?.[0]).toMatchObject({ target, signal: expect.any(AbortSignal) })
      await router.invoke('target.disconnect', { id: target.id })
    } finally {
      ssh.mockReset()
      backendConfig.userData = previousUserData
      await rm(userData, { recursive: true, force: true })
    }
  })

  it.each([
    { enabled: false, port: 47390 },
    { enabled: true, port: 48000 },
  ])('自动配置沿用远端监听（已有监听 $enabled），保存后首次连接即可用直连', async ({ enabled, port }) => {
    const userData = await mkdtemp(join(tmpdir(), 'qn-direct-target-'))
    const previousUserData = backendConfig.userData
    backendConfig.userData = userData
    const target: SshTarget = { id: 'remote', name: '远程', kind: 'ssh', host: 'host', port: 22, username: 'user', auth: { kind: 'password' } }
    const status = { enabled, listening: enabled, ...(enabled ? { listen: String(port), allowPublic: true } : {}) }
    const token = 't'.repeat(43)
    const fingerprint = 'ab'.repeat(32)
    const code = encodeDirectCode({ v: 1, hosts: [target.host], port, token, fingerprint })
    const executed: Array<readonly string[]> = []
    const remote = vi.mocked(runRemoteServerCommands)
    const direct = vi.mocked(connectDirectTarget)
    const load = vi.mocked(loadSecret)
    const save = vi.mocked(saveSecret)
    let saved: SavedSecret = { password: 'saved-password' }
    load.mockImplementation(async () => saved)
    save.mockImplementation(async (_id, value) => { saved = value })
    remote.mockImplementation(async (_context, commands) => {
      const results: Array<Record<string, unknown>> = []
      for (const command of commands) {
        const args = typeof command === 'function' ? command(results.at(-1)) : command
        if (!args) continue
        executed.push(args)
        results.push(args[1] === 'grant' ? { code, grantId: 'grant' } : status)
      }
      return results
    })
    direct.mockResolvedValue({ request: vi.fn(), codexSend: vi.fn(), close: vi.fn() })
    const router = new BackendRouter()
    registerTargetMethods(router)
    try {
      await writeTargets(userData, [target])
      const updated = await router.invoke('target.enableDirect', { id: target.id, reuseListener: true })
      expect(updated).toMatchObject({ direct: { host: target.host, port, fingerprint, grantId: 'grant' } })
      expect(remote).toHaveBeenCalledOnce()
      expect(executed).toEqual([
        ['direct', 'status'],
        ...(!enabled ? [['direct', 'enable', '--listen', '47390']] : []),
        ['direct', 'grant', '--name', expect.any(String), '--host', target.host],
      ])
      expect(await readTargets(userData)).toContainEqual(updated)
      expect(saved).toEqual({ password: 'saved-password', directToken: token })

      await router.invoke('target.connect', { id: target.id })
      expect(direct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        target: expect.objectContaining({ host: target.host, port, fingerprint }), token,
      }))
      expect(connectSshTarget).not.toHaveBeenCalled()
    } finally {
      await router.invoke('target.disconnect', { id: target.id })
      for (const mock of [remote, direct, load, save]) mock.mockReset()
      backendConfig.userData = previousUserData
      await rm(userData, { recursive: true, force: true })
    }
  })
})
