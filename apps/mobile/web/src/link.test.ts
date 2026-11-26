import { describe, expect, it } from 'vitest'
import {
  buildConnectionInfo,
  buildPairingLink,
  CONNECTION_INFO_TITLE,
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

const FP = 'ab'.repeat(32)
const INFO: PairingInfo = {
  host: 'frp.example.com',
  port: 7001,
  fp: FP,
  name: '书房电脑',
  code: 'Pa7s!word',
}

describe('normalizeFingerprint / parsePort', () => {
  it('规范化大写与冒号分隔的指纹', () => {
    expect(normalizeFingerprint(FP.toUpperCase())).toBe(FP)
    expect(normalizeFingerprint(FP.toUpperCase().replace(/(..)/g, '$1:').replace(/:$/, ''))).toBe(FP)
    expect(normalizeFingerprint('SHA256:xyz')).toBeNull()
    expect(normalizeFingerprint('a'.repeat(63))).toBeNull()
    expect(normalizeFingerprint('z'.repeat(64))).toBeNull()
    expect(normalizeFingerprint(null)).toBeNull()
  })

  it('端口只接受 1–65535 的十进制', () => {
    expect(parsePort('38500')).toBe(38500)
    expect(parsePort(22)).toBe(22)
    expect(parsePort('0')).toBeNull()
    expect(parsePort('65536')).toBeNull()
    expect(parsePort('38a')).toBeNull()
    expect(parsePort('')).toBeNull()
  })
})

describe('buildPairingLink / parsePairingLink', () => {
  it('往返解析中英混合名称与特殊字符密码', () => {
    const link = buildPairingLink(INFO)
    expect(link.startsWith('qingcode-next://pair?v=1&')).toBe(true)
    expect(parsePairingLink(link)).toEqual(INFO)
    expect(draftFromInfo(INFO)).toEqual({
      name: INFO.name,
      host: INFO.host,
      port: INFO.port,
      fp: FP,
      code: INFO.code,
    })
  })

  it('从聊天软件转发的任意文本中提取第一条链接', () => {
    const info = buildConnectionInfo(INFO)
    const noisy = `转发给你：\n${info.text}\n装好以后告诉我。）`
    expect(parsePairingLink(noisy)).toEqual(INFO)
    expect(parsePairingLink(`无用文本 ${buildPairingLink(INFO)}。`)).toEqual(INFO)
  })

  it('连接信息文本包含电脑名、地址与链接', () => {
    const info = buildConnectionInfo(INFO)
    expect(info.text).toContain(CONNECTION_INFO_TITLE)
    expect(info.text).toContain(`电脑：${INFO.name}`)
    expect(info.text).toContain('地址：frp.example.com:7001')
    expect(info.text).toContain(info.link)
  })

  it('支持 IPv4、IPv6（方括号/裸地址）与域名', () => {
    const bracketed = { ...INFO, host: '[2001:db8::1]', port: 38500 }
    expect(parsePairingLink(buildPairingLink(bracketed))?.host).toBe('[2001:db8::1]')
    expect(parsePairingLink(buildPairingLink(bracketed))?.port).toBe(38500)
    const bare = { ...INFO, host: '2001:db8::1' }
    expect(parsePairingLink(buildPairingLink(bare))?.host).toBe('2001:db8::1')
    expect(parsePairingLink(buildPairingLink({ ...INFO, host: '192.168.10.87' }))?.host).toBe('192.168.10.87')
    expect(isValidHost('192.168.10.999')).toBe(false)
    expect(isValidHost('bad host')).toBe(false)
    expect(isValidHost('')).toBe(false)
  })

  it('拒绝版本不符、指纹/端口/主机不合法或缺字段', () => {
    const base = buildPairingLink(INFO)
    expect(parsePairingLink(base.replace('v=1', 'v=2'))).toBeNull()
    expect(parsePairingLink(base.replace(`fp=${FP}`, 'fp=xyz'))).toBeNull()
    expect(parsePairingLink(base.replace('port=7001', 'port=99999'))).toBeNull()
    expect(parsePairingLink(base.replace(/host=[^&]*/, 'host='))).toBeNull()
    expect(parsePairingLink(base.replace('&code=Pa7s%21word', ''))).toBeNull()
    expect(parsePairingLink('没有任何链接')).toBeNull()
    expect(parsePairingLink(123)).toBeNull()
  })
})

describe('formatAddress / parseAddress', () => {
  it('IPv6 地址加方括号并避免重复端口', () => {
    expect(formatAddress('192.168.1.2', 38500)).toBe('192.168.1.2:38500')
    expect(formatAddress('2001:db8::1', 7001)).toBe('[2001:db8::1]:7001')
    expect(formatAddress('[2001:db8::1]', 7001)).toBe('[2001:db8::1]:7001')
    expect(formatAddress('[2001:db8::1]:7001', 38500)).toBe('[2001:db8::1]:7001')
  })

  it('拆分 host:port 与单独主机', () => {
    expect(parseAddress('frp.example.com:7001')).toEqual({ host: 'frp.example.com', port: 7001 })
    expect(parseAddress('192.168.10.87')).toEqual({ host: '192.168.10.87', port: null })
    expect(parseAddress('[2001:db8::1]:7001')).toEqual({ host: '[2001:db8::1]', port: 7001 })
    expect(parseAddress('[2001:db8::1]')).toEqual({ host: '[2001:db8::1]', port: null })
    expect(parseAddress('2001:db8::1:7001')).toEqual({ host: '2001:db8::1:7001', port: null })
    expect(parseAddress('')).toBeNull()
    expect(parseAddress('host:99999')).toBeNull()
  })
})

describe('isValidPairingCode', () => {
  it('6–20 位、区分大小写且不含空白', () => {
    expect(isValidPairingCode('mock1234')).toBe(true)
    expect(isValidPairingCode('AbCDeF')).toBe(true)
    expect(isValidPairingCode('abcde')).toBe(false)
    expect(isValidPairingCode('a'.repeat(21))).toBe(false)
    expect(isValidPairingCode('abc 123')).toBe(false)
  })
})
