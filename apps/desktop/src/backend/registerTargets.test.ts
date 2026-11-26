import { describe, expect, it } from 'vitest'
import { registerTargetMethods } from './registerTargets'
import { BackendRouter, type WirePort } from './router'

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
})
