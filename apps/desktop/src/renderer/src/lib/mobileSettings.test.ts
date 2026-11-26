import { describe, expect, it } from 'vitest'
import type { MobileSettings } from '../../../shared/backendApi'
import {
  buildAddressOptions,
  buildSettingsPatch,
  draftFromSettings,
  formatAddress,
  formatDeviceTime,
  gatewayStatus,
  groupFingerprint,
  isValidHost,
  isValidPairingCode,
  normalizePublicAddress,
  parsePort,
} from './mobileSettings'

const fingerprint = 'a'.repeat(64)

const settings = (patch: Partial<MobileSettings> = {}): MobileSettings => ({
  enabled: true,
  port: 38500,
  hasPassword: true,
  publicAddresses: ['frp.example.com:7001'],
  lanAddresses: ['192.168.10.87:38500', '10.0.0.2:38500'],
  fingerprint,
  running: true,
  ...patch,
})

const draft = () => draftFromSettings(settings())

describe('端口与配对密码校验', () => {
  it('端口只接受 1–65535 的整数', () => {
    expect(parsePort(' 7001 ')).toBe(7001)
    expect(parsePort('1')).toBe(1)
    expect(parsePort('65535')).toBe(65535)
    expect(parsePort('0')).toBeNull()
    expect(parsePort('65536')).toBeNull()
    expect(parsePort('38a00')).toBeNull()
    expect(parsePort('1e3')).toBeNull()
    expect(parsePort('')).toBeNull()
  })

  it('配对密码 6–20 位且不含空白与控制字符', () => {
    expect(isValidPairingCode('abc123')).toBe(true)
    expect(isValidPairingCode('A'.repeat(20))).toBe(true)
    expect(isValidPairingCode('abc12')).toBe(false)
    expect(isValidPairingCode('A'.repeat(21))).toBe(false)
    expect(isValidPairingCode('abc 123')).toBe(false)
    expect(isValidPairingCode('abc\n123')).toBe(false)
  })
})

describe('对外地址校验与规范化', () => {
  it('主机允许域名、IPv4 与 IPv6', () => {
    expect(isValidHost('frp.example.com')).toBe(true)
    expect(isValidHost('192.168.10.93')).toBe(true)
    expect(isValidHost('192.168.10.999')).toBe(false)
    expect(isValidHost('bad host')).toBe(false)
    expect(isValidHost('2001:db8::1')).toBe(true)
    expect(isValidHost('[2001:db8::1]')).toBe(true)
    expect(isValidHost('')).toBe(false)
  })

  it('规范化必须带端口，IPv6 自动补方括号', () => {
    expect(normalizePublicAddress(' frp.example.com:7001 ')).toBe('frp.example.com:7001')
    expect(normalizePublicAddress('192.168.1.2:38500')).toBe('192.168.1.2:38500')
    expect(normalizePublicAddress('[2001:db8::1]:7001')).toBe('[2001:db8::1]:7001')
    expect(normalizePublicAddress('2001:db8::1:7001')).toBe('[2001:db8::1]:7001')
    expect(normalizePublicAddress('frp.example.com')).toBeNull()
    expect(normalizePublicAddress('frp.example.com:0')).toBeNull()
    expect(normalizePublicAddress('frp.example.com:65536')).toBeNull()
    expect(normalizePublicAddress('bad host:7001')).toBeNull()
    expect(normalizePublicAddress('[xyz]:7001')).toBeNull()
  })

  it('显示用地址不重复追加端口', () => {
    expect(formatAddress('192.168.1.2', 38500)).toBe('192.168.1.2:38500')
    expect(formatAddress('2001:db8::1', 7001)).toBe('[2001:db8::1]:7001')
    expect(formatAddress('[2001:db8::1]', 7001)).toBe('[2001:db8::1]:7001')
    expect(formatAddress('[2001:db8::1]:7001', 38500)).toBe('[2001:db8::1]:7001')
  })
})

describe('地址选项', () => {
  it('局域网在前、对外在后，去重并剔除无效项', () => {
    const options = buildAddressOptions(
      ['192.168.1.2:38500', '192.168.1.2:38500', ''],
      ['frp.example.com:7001', '192.168.1.2:38500', 'bad'],
    )
    expect(options).toEqual([
      { value: '192.168.1.2:38500', kind: 'lan' },
      { value: 'frp.example.com:7001', kind: 'public' },
    ])
  })

  it('没有地址时返回空列表', () => {
    expect(buildAddressOptions([], [])).toEqual([])
  })
})

describe('设置草稿与补丁', () => {
  it('初始草稿不含密码，未改动时不提交任何字段', () => {
    const value = draft()
    expect(value.password).toBe('')
    expect(value.publicAddresses).toEqual(['frp.example.com:7001'])
    expect(buildSettingsPatch(value, settings())).toEqual({ ok: true, patch: {} })
  })

  it('只提交改动的字段，密码留空表示不修改', () => {
    const result = buildSettingsPatch(
      { ...draft(), enabled: false, port: '38501' },
      settings(),
    )
    expect(result).toEqual({ ok: true, patch: { enabled: false, port: 38501 } })
  })

  it('新密码与规范化、去重后的地址会提交', () => {
    const result = buildSettingsPatch(
      {
        ...draft(),
        password: 'abc123',
        publicAddresses: [' 2001:db8::1:7001 ', 'frp.example.com:7001', 'frp.example.com:7001'],
      },
      settings(),
    )
    expect(result).toEqual({
      ok: true,
      patch: {
        password: 'abc123',
        publicAddresses: ['[2001:db8::1]:7001', 'frp.example.com:7001'],
      },
    })
  })

  it('手机终端开关默认关闭，只有显式修改时才提交', () => {
    expect(draft().terminalEnabled).toBe(false)
    expect(buildSettingsPatch({ ...draft(), terminalEnabled: true }, settings())).toEqual({
      ok: true, patch: { terminalEnabled: true },
    })
  })

  it('无效端口、密码、地址给出可读错误', () => {
    expect(buildSettingsPatch({ ...draft(), port: '70000' }, settings())).toEqual({
      ok: false,
      error: '端口需为 1–65535 的整数',
    })
    expect(buildSettingsPatch({ ...draft(), password: 'abc' }, settings())).toEqual({
      ok: false,
      error: '配对密码需为 6–20 位且不含空白字符',
    })
    expect(buildSettingsPatch({ ...draft(), publicAddresses: ['frp.example.com'] }, settings())).toEqual({
      ok: false,
      error: '对外地址「frp.example.com」无效，需填 host:port',
    })
  })
})

describe('指纹分组与设备时间', () => {
  it('指纹按 4 位分组并忽略冒号、空格、大小写', () => {
    expect(groupFingerprint(fingerprint)).toBe('aaaa '.repeat(16).trimEnd())
    const colonSeparated = (fingerprint.match(/.{1,4}/g) ?? []).join(':').toUpperCase()
    expect(groupFingerprint(colonSeparated)).toBe('aaaa '.repeat(16).trimEnd())
    expect(groupFingerprint('')).toBe('')
    expect(groupFingerprint('abc')).toBe('abc')
  })

  it('无效时间戳显示占位符，有效时间为本地 YYYY-MM-DD HH:mm', () => {
    expect(formatDeviceTime(0)).toBe('—')
    expect(formatDeviceTime(Number.NaN)).toBe('—')
    expect(formatDeviceTime(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatDeviceTime(1735689600000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('网关运行状态', () => {
  it('按设置给出状态与说明', () => {
    expect(gatewayStatus(null).label).toBe('加载中')
    expect(gatewayStatus(settings({ error: '端口 38500 已被占用' }))).toEqual({
      label: '启动失败',
      tone: 'danger',
      detail: '端口 38500 已被占用',
    })
    expect(gatewayStatus(settings({ enabled: false, running: false })).label).toBe('已停用')
    expect(gatewayStatus(settings()).label).toBe('运行中')
    expect(gatewayStatus(settings({ running: false, hasPassword: false })).label).toBe('待设置密码')
    expect(gatewayStatus(settings({ running: false })).label).toBe('未运行')
  })
})
