import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backendConfig } from './config'
import { registerDataMethods } from './registerData'
import { BackendRouter, type WirePort } from './router'
import { readSecretStore } from './secretStore'

class FakePort implements WirePort {
  readonly messages: unknown[] = []
  private listener: ((e: { data: unknown }) => void) | null = null

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  on(_event: 'message', listener: (e: { data: unknown }) => void): void {
    this.listener = listener
  }

  start(): void { /* 无需真实 port */ }
  close(): void { /* 无需真实 port */ }

  send(data: unknown): void {
    this.listener?.({ data })
  }
}

let userData = ''
const originalUserData = backendConfig.userData

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'qn-register-data-'))
  backendConfig.userData = userData
})

afterAll(async () => {
  backendConfig.userData = originalUserData
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

// handler 里有多次文件 IO，一个 setImmediate 不足以等到回包。
async function call(port: FakePort, router: BackendRouter, id: number, method: string, params?: unknown) {
  const before = port.messages.length
  port.send({ t: 'req', id, method, params })
  for (let i = 0; i < 100 && port.messages.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return port.messages[port.messages.length - 1]
}

describe('registerDataMethods', () => {
  it('注册项目方法且不被占位覆盖', async () => {
    const port = new FakePort()
    const router = new BackendRouter()
    registerDataMethods(router)
    router.registerNotImplemented(['projects.list', 'projects.save', 'projects.remove', 'legacy.detect', 'legacy.import', 'target.forgetSecret'])
    router.attachPort(port)

    expect(await call(port, router, 1, 'projects.save', { targetId: 'local', path: 'C:\\work\\demo\\' }))
      .toMatchObject({ ok: true, result: { targetId: 'local', name: 'demo', path: 'C:\\work\\demo' } })
    const saved = port.messages[0] as { result: { id: string } }
    expect(await call(port, router, 2, 'projects.list', { targetId: 'local' }))
      .toMatchObject({ ok: true, result: [{ id: saved.result.id }] })
    expect(await call(port, router, 3, 'projects.save', { targetId: 'local', path: 'C:\\work\\demo' }))
      .toMatchObject({ ok: true, result: { id: saved.result.id } })
    expect(await call(port, router, 4, 'projects.remove', { id: saved.result.id }))
      .toMatchObject({ ok: true })
    expect(await call(port, router, 5, 'projects.list', {}))
      .toMatchObject({ ok: true, result: [] })
  })

  it('参数校验与旧库缺失给出结构化错误', async () => {
    const port = new FakePort()
    const router = new BackendRouter()
    registerDataMethods(router)
    router.attachPort(port)

    expect(await call(port, router, 1, 'projects.save', { targetId: '', path: '' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(await call(port, router, 2, 'projects.remove', {}))
      .toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(await call(port, router, 3, 'legacy.detect', { path: join(userData, 'nope.db') }))
      .toMatchObject({ ok: true, result: { found: false } })
    expect(await call(port, router, 4, 'legacy.import', { path: join(userData, 'nope.db'), includeSecrets: false }))
      .toMatchObject({ ok: false })
  })

  it('target.forgetSecret 删除已保存凭据', async () => {
    await writeFile(join(userData, 'secrets.json'), JSON.stringify({ 'ssh-1': 'YQ==' }), 'utf8')
    const port = new FakePort()
    const router = new BackendRouter()
    registerDataMethods(router)
    router.attachPort(port)
    expect(await call(port, router, 1, 'target.forgetSecret', { id: 'ssh-1' })).toMatchObject({ ok: true })
    expect(await readSecretStore(userData)).toEqual({})
    expect(JSON.parse(await readFile(join(userData, 'secrets.json'), 'utf8'))).toEqual({})
  })
})
