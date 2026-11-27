import { describe, expect, it } from 'vitest'
import { decodeDirectCode, encodeDirectCode, isValidFingerprint, normalizeFingerprint } from './direct'

const fp = 'ab'.repeat(32)

describe('直连连接码', () => {
  it('编码后可原样解码，容忍空白换行', () => {
    const code = encodeDirectCode({ v: 1, hosts: ['192.168.10.87'], port: 47390, token: 't'.repeat(43), fingerprint: fp, name: '测试机' })
    const wrapped = `  ${code.slice(0, 20)}\n${code.slice(20)}  `
    expect(decodeDirectCode(wrapped)).toEqual({
      v: 1,
      hosts: ['192.168.10.87'],
      port: 47390,
      token: 't'.repeat(43),
      fingerprint: fp,
      name: '测试机',
    })
  })

  it('拒绝前缀错误、字段缺失或非法的连接码', () => {
    expect(decodeDirectCode('hello')).toBeNull()
    expect(decodeDirectCode('qn-direct:!!!')).toBeNull()
    const bad = encodeDirectCode({ v: 1, hosts: [], port: 70000, token: 't'.repeat(43), fingerprint: fp })
    expect(decodeDirectCode(bad)).toBeNull()
    const shortToken = encodeDirectCode({ v: 1, hosts: [], port: 1, token: 'x', fingerprint: fp })
    expect(decodeDirectCode(shortToken)).toBeNull()
  })

  it('指纹归一：去冒号空白并转小写', () => {
    const colon = fp.toUpperCase().match(/../g)!.join(':')
    expect(normalizeFingerprint(colon)).toBe(fp)
    expect(isValidFingerprint(colon)).toBe(true)
    expect(isValidFingerprint('abc')).toBe(false)
  })
})
