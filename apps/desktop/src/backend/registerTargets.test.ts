import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../shared/backendApi'
import { backendConfig } from './config'
import { registerTargetMethods } from './registerTargets'
import { BackendRouter, type WirePort } from './router'
import { connectSshTarget } from './sshTarget'
import { writeTargets } from './targetStore'

vi.mock('./sshTarget', () => ({ connectSshTarget: vi.fn(), runRemoteServerCommands: vi.fn(), testSshTarget: vi.fn() }))

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
})
