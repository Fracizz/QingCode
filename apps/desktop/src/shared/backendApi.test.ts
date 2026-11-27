import { describe, expect, it } from 'vitest'
import { isBackendEventMessage, isBackendRequest, isBackendResponse } from './backendApi'

describe('线消息守卫', () => {
  it('识别 req', () => {
    expect(isBackendRequest({ t: 'req', id: 1, method: 'targets.list' })).toBe(true)
    expect(isBackendRequest({ t: 'req', id: Number.NaN, method: 'x' })).toBe(false)
    expect(isBackendRequest({ t: 'req', id: 1 })).toBe(false)
    expect(isBackendRequest({ t: 'evt', id: 1, method: 'x' })).toBe(false)
  })

  it('识别 res 并校验 error 形状', () => {
    expect(isBackendResponse({ t: 'res', id: 2, ok: true, result: null })).toBe(true)
    expect(isBackendResponse({ t: 'res', id: 2, ok: true })).toBe(false)
    expect(isBackendResponse({ t: 'res', id: 2, ok: false, error: { code: 'auth', message: 'x' } })).toBe(true)
    expect(isBackendResponse({ t: 'res', id: 2, ok: false, error: 'x' })).toBe(false)
  })

  it('识别 evt 且要求 payload 存在', () => {
    expect(isBackendEventMessage({ t: 'evt', name: 'target.state', payload: {} })).toBe(true)
    expect(isBackendEventMessage({ t: 'evt', name: 'target.state' })).toBe(false)
  })
})
