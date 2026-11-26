import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RouterError } from '../router'
import type { SecretCipher } from '../secretStore'
import {
  DEFAULT_MOBILE_SETTINGS,
  MobileSettingsStore,
  lanAddressesFromInterfaces,
  mobileDirectory,
  normalizePublicAddresses,
  parseSettings,
  readSettings,
  validateSettingsPatch,
  writeSettings,
} from './settings'

const tempDirs: string[] = []
const cipher: SecretCipher = {
  encrypt: async (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: async (encoded) => Buffer.from(encoded, 'base64').toString('utf8'),
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qn-mobile-settings-'))
  tempDirs.push(dir)
  return dir
}

describe('设置纯逻辑', () => {
  it('兼容损坏设置并规范化对外地址', () => {
    expect(parseSettings(null)).toEqual({ ...DEFAULT_MOBILE_SETTINGS, publicAddresses: [] })
    expect(parseSettings({ enabled: true, port: '7001', publicAddresses: ['frp.example.com:7001'] }))
      .toEqual({ enabled: true, port: 7001, publicAddresses: ['frp.example.com:7001'] })
    expect(parseSettings({ publicAddresses: ['bad'] }))
      .toEqual({ ...DEFAULT_MOBILE_SETTINGS, publicAddresses: [] })
    expect(normalizePublicAddresses(['[::1]:7002', 'frp.example.com:7001', 'frp.example.com:7001']))
      .toEqual(['[::1]:7002', 'frp.example.com:7001'])
    expect(normalizePublicAddresses(['bad'])).toBeNull()
  })

  it('严格校验设置补丁', () => {
    expect(validateSettingsPatch(undefined)).toEqual({})
    expect(validateSettingsPatch({ enabled: true, port: 7001, password: 'Pair.Code!' })).toEqual({
      enabled: true,
      port: 7001,
      password: 'Pair.Code!',
    })
    expect(() => validateSettingsPatch([])).toThrow(RouterError)
    expect(() => validateSettingsPatch({ enabled: 'yes' })).toThrow(/布尔值/)
    expect(() => validateSettingsPatch({ port: 0 })).toThrow(/端口/)
    expect(() => validateSettingsPatch({ password: 'short' })).toThrow(/6–20/)
    expect(() => validateSettingsPatch({ publicAddresses: ['bad'] })).toThrow(/host:port/)
  })

  it('只列非内部 IPv4 并去重', () => {
    const interfaces = {
      eth0: [
        { address: '192.168.10.87', family: 'IPv4', internal: false },
        { address: '192.168.10.87', family: 4, internal: false },
        { address: '::1', family: 'IPv6', internal: false },
        { address: '127.0.0.1', family: 'IPv4', internal: true },
      ],
      wlan: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      empty: undefined,
    }
    expect(lanAddressesFromInterfaces(interfaces, 38500)).toEqual([
      '10.0.0.5:38500',
      '192.168.10.87:38500',
    ])
  })
})

describe('MobileSettingsStore', () => {
  it('设置文件不含明文，配对密码经注入的 cipher 保存与读取', async () => {
    const userData = await tempDir()
    const store = new MobileSettingsStore(userData, cipher)
    expect(await store.hasPassword()).toBe(false)
    expect(await store.getPassword()).toBeNull()

    await store.setPassword('Pair.Code!')
    await store.write({
      enabled: false,
      port: 38500,
      publicAddresses: ['frp.example.com:7001'],
    })
    expect(await store.hasPassword()).toBe(true)
    expect(await store.getPassword()).toBe('Pair.Code!')
    expect(await store.read()).toEqual({
      enabled: false,
      port: 38500,
      publicAddresses: ['frp.example.com:7001'],
    })

    const settingsRaw = await readFile(join(mobileDirectory(userData), 'settings.json'), 'utf8')
    const secretsRaw = await readFile(join(userData, 'secrets.json'), 'utf8')
    expect(settingsRaw).not.toContain('Pair.Code!')
    expect(secretsRaw).not.toContain('Pair.Code!')
    await expect(store.setPassword('short')).rejects.toThrow(RouterError)
  })

  it('损坏的 settings.json 退化成默认值且可重新写入', async () => {
    const directory = mobileDirectory(await tempDir())
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'settings.json'), '{bad', 'utf8')
    expect(await readSettings(directory)).toEqual({
      ...DEFAULT_MOBILE_SETTINGS,
      publicAddresses: [],
    })
    await writeSettings(directory, {
      enabled: true,
      port: 7001,
      publicAddresses: ['frp.example.com:7001'],
    })
    expect(await readSettings(directory)).toMatchObject({ enabled: true, port: 7001 })
  })
})
