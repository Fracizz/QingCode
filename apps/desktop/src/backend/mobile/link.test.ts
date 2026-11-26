import { describe, expect, it } from 'vitest'
import {
  buildConnectionInfo,
  buildPairingLink,
  draftFromInfo,
  formatAddress,
  isValidHost,
  isValidPairingCode,
  normalizeFingerprint,
  parseAddress,
  parsePairingLink,
  parsePort,
  type PairingInfo,
} from './link'

const fp = 'a1b2c3d4'.repeat(8)
const sample: PairingInfo = {
  host: 'frp.example.com',
  port: 7001,
  fp,
  name: '验收电脑',
  code: 'Pass.word.',
}

describe('连接地址与配对链接', () => {
  it('校验指纹、端口与 IPv4/IPv6/域名', () => {
    expect(normalizeFingerprint(fp.toUpperCase())).toBe(fp)
    expect(normalizeFingerprint(fp.replace(/(.{2})/g, '$1:'))).toBe(fp)
    expect(normalizeFingerprint('nope')).toBeNull()
    expect(parsePort('38500')).toBe(38500)
    expect(parsePort(38500)).toBe(38500)
    expect(parsePort(70000)).toBeNull()
    expect(parsePort('38a')).toBeNull()
    expect(isValidHost('192.168.10.93')).toBe(true)
    expect(isValidHost('999.1.1.1')).toBe(false)
    expect(isValidHost('frp_example.com')).toBe(true)
    expect(isValidHost('[::1]')).toBe(true)
    expect(isValidHost('::1')).toBe(true)
    expect(isValidHost('[::::]')).toBe(false)
    expect(isValidHost('bad!host')).toBe(false)
  })

  it('解析和显示 host:port，IPv6 自动加方括号', () => {
    expect(parseAddress('192.168.10.93:38500')).toEqual({ host: '192.168.10.93', port: 38500 })
    expect(parseAddress('[::1]:7001')).toEqual({ host: '[::1]', port: 7001 })
    expect(parseAddress('::1:7001')).toEqual({ host: '::1', port: 7001 })
    expect(parseAddress('frp.example.com')).toEqual({ host: 'frp.example.com', port: null })
    expect(parseAddress('host:99999')).toBeNull()
    expect(formatAddress('::1', 38500)).toBe('[::1]:38500')
    expect(formatAddress('[::1]', 38500)).toBe('[::1]:38500')
    expect(formatAddress('192.168.10.93', 38500)).toBe('192.168.10.93:38500')
  })

  it('生成符合 §9.3 的复制文本，并从任意文字中还原字段', () => {
    const info = buildConnectionInfo(sample)
    expect(info.text.split('\n')).toEqual([
      'QingCode Next 手机连接',
      '电脑：验收电脑',
      '地址：frp.example.com:7001',
      '在 QingCode Next 手机版「添加连接」中粘贴即可导入：',
      info.link,
    ])
    expect(info.link.startsWith('qingcode-next://pair?v=1&')).toBe(true)
    expect(info.link).toContain('code=Pass%2Eword%2E')
    expect(parsePairingLink(info.text)).toEqual(sample)
    expect(parsePairingLink(`转发文本：${info.link}。 复制后打开`)).toEqual(sample)
    expect(parsePairingLink(`${info.link}.`)).toEqual(sample)
    expect(draftFromInfo(sample)).toEqual({
      name: sample.name,
      host: sample.host,
      port: sample.port,
      fp: sample.fp,
      code: sample.code,
    })
  })

  it('支持 IPv6 主机并拒绝坏链接', () => {
    const link = buildPairingLink({ ...sample, host: '[::1]', port: 38500 })
    expect(parsePairingLink(`请粘贴 ${link}`)).toEqual({
      ...sample,
      host: '[::1]',
      port: 38500,
    })
    expect(parsePairingLink(link.replace('v=1', 'v=2'))).toBeNull()
    expect(parsePairingLink(link.replace('port=38500', 'port=70000'))).toBeNull()
    expect(parsePairingLink(link.replace(fp, 'bad'))).toBeNull()
    expect(parsePairingLink(link.replace('host=%5B%3A%3A1%5D', 'host=bad%21host'))).toBeNull()
    expect(parsePairingLink('没有链接的一段话')).toBeNull()
    expect(parsePairingLink(42)).toBeNull()
  })

  it('配对密码保持大小写，拒绝空白与控制字符', () => {
    expect(isValidPairingCode('AbCd12')).toBe(true)
    expect(isValidPairingCode('abcde')).toBe(false)
    expect(isValidPairingCode('a'.repeat(21))).toBe(false)
    expect(isValidPairingCode('abc def')).toBe(false)
    expect(isValidPairingCode('abc\u0000def')).toBe(false)
  })
})
