import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@qn/protocol'
import { checkHello } from './validation'

const token = 'a'.repeat(64)
const hello = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  token,
  client: { name: 'renderer', version: '0.0.1' },
  ...overrides,
})

describe('checkHello', () => {
  it('合法首帧通过', () => {
    expect(checkHello(hello(), { token })).toEqual({
      ok: true,
      client: { name: 'renderer', version: '0.0.1' },
    })
  })

  it('protocol 不符先于 token 判定，返回 protocol 错误', () => {
    expect(checkHello(hello({ protocol: 2, token: 'wrong' }), { token })).toMatchObject({
      ok: false,
      code: 'protocol',
    })
  })

  it('token 错返回 auth 错误', () => {
    expect(checkHello(hello({ token: 'b'.repeat(64) }), { token })).toMatchObject({
      ok: false,
      code: 'auth',
    })
    expect(checkHello(hello({ token: undefined }), { token })).toMatchObject({
      ok: false,
      code: 'auth',
    })
  })

  it('首帧不是 hello 或 client 不完整返回 protocol 错误', () => {
    expect(checkHello({ t: 'req', id: 1, method: 'ping' }, { token })).toMatchObject({
      ok: false,
      code: 'protocol',
    })
    expect(checkHello(null, { token })).toMatchObject({ ok: false, code: 'protocol' })
    expect(checkHello(hello({ client: { name: 'x' } }), { token })).toMatchObject({
      ok: false,
      code: 'protocol',
    })
  })

  it('自定义协议版本可用于显式校验', () => {
    expect(checkHello(hello({ protocol: 7 }), { token, protocol: 7 })).toMatchObject({ ok: true })
  })
})
