import { describe, expect, it } from 'vitest'
import { BackendRouter, RouterError, toWireError, type WirePort } from './router'

class FakePort implements WirePort {
  readonly messages: unknown[] = []
  started = false
  closed = false
  private listener: ((e: { data: unknown }) => void) | null = null

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  on(_event: 'message', listener: (e: { data: unknown }) => void): void {
    this.listener = listener
  }

  start(): void {
    this.started = true
  }

  close(): void {
    this.closed = true
  }

  send(data: unknown): void {
    this.listener?.({ data })
  }
}

const req = (id: number, method: string, params?: unknown) => ({ t: 'req', id, method, params })

describe('BackendRouter', () => {
  it('调用已注册方法并回 ok:true', async () => {
    const port = new FakePort()
    const router = new BackendRouter()
    router.register('targets.list', () => [
      { id: 'local' as const, kind: 'local' as const, name: '本机' },
    ])
    router.attachPort(port)
    expect(port.started).toBe(true)

    port.send(req(1, 'targets.list'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(port.messages).toEqual([
      { t: 'res', id: 1, ok: true, result: [{ id: 'local', kind: 'local', name: '本机' }] },
    ])
  })

  it('未知方法与未实现方法都转 ok:false', async () => {
    const port = new FakePort()
    const router = new BackendRouter()
    router.registerNotImplemented(['projects.list'])
    router.attachPort(port)

    port.send(req(7, 'nope'))
    port.send(req(8, 'projects.list', {}))
    await new Promise((resolve) => setImmediate(resolve))
    expect(port.messages).toEqual([
      { t: 'res', id: 7, ok: false, error: { code: 'unknown_method', message: '未知方法：nope' } },
      { t: 'res', id: 8, ok: false, error: { code: 'not_implemented', message: 'projects.list 尚未实现' } },
    ])
  })

  it('异步 handler 抛错也能转成结构化错误', async () => {
    const port = new FakePort()
    const router = new BackendRouter()
    router.register('targets.save', async () => {
      throw new RouterError('invalid_params', '主机不能为空')
    })
    router.attachPort(port)

    port.send(req(2, 'targets.save', {}))
    await new Promise((resolve) => setImmediate(resolve))
    expect(port.messages).toEqual([
      { t: 'res', id: 2, ok: false, error: { code: 'invalid_params', message: '主机不能为空' } },
    ])
  })

  it('忽略非法线消息并支持事件推送', () => {
    const port = new FakePort()
    const router = new BackendRouter()
    router.attachPort(port)
    port.send({ t: 'res', id: 1, ok: true, result: 1 })
    port.send(null)
    expect(port.messages).toHaveLength(0)

    router.emit('target.state', { id: 'local', state: 'ready' })
    expect(port.messages).toEqual([
      { t: 'evt', name: 'target.state', payload: { id: 'local', state: 'ready' } },
    ])
  })

  it('占位注册不会覆盖先注册的真实实现', async () => {
    const port = new FakePort()
    const router = new BackendRouter()
    router.register('projects.list', () => [{ id: 'p1', targetId: 'local', name: 'p', path: 'C:\\p', lastOpenedAt: 1 }])
    router.registerNotImplemented(['projects.list'])
    router.attachPort(port)

    port.send(req(9, 'projects.list', { targetId: 'local' }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(port.messages[0]).toMatchObject({ t: 'res', id: 9, ok: true })
  })

  it('重建通道时关闭旧 port 且旧通道请求不再回包', async () => {
    const oldPort = new FakePort()
    const newPort = new FakePort()
    const router = new BackendRouter()
    router.register('targets.list', () => [])
    router.attachPort(oldPort)
    router.attachPort(newPort)

    expect(oldPort.closed).toBe(true)
    oldPort.send(req(3, 'targets.list'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(newPort.messages).toHaveLength(0)

    newPort.send(req(4, 'targets.list'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(newPort.messages).toEqual([{ t: 'res', id: 4, ok: true, result: [] }])
  })
})

describe('toWireError', () => {
  it('区分 RouterError 与普通 Error', () => {
    expect(toWireError(new RouterError('auth', '拒绝'))).toEqual({ code: 'auth', message: '拒绝' })
    expect(toWireError(new Error('boom'))).toEqual({ code: 'internal', message: 'boom' })
    expect(toWireError('boom')).toEqual({ code: 'internal', message: 'boom' })
  })
})
