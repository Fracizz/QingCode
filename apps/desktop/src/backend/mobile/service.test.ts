import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecretCipher } from '../secretStore'
import type { RouterGateway } from './gateway'
import { parsePairingLink } from './link'
import { DeviceStore, deviceFilePath } from './pairing'
import { MobileService } from './service'
import { mobileDirectory } from './settings'

const cipher: SecretCipher = {
  encrypt: async (text) => Buffer.from(text, 'utf8').toString('base64'),
  decrypt: async (encoded) => Buffer.from(encoded, 'base64').toString('utf8'),
}

const router: RouterGateway = {
  invoke: async () => null,
  onEmit: () => () => undefined,
}

const tempDirs: string[] = []
let activeService: MobileService | null = null

afterEach(async () => {
  await activeService?.dispose().catch(() => undefined)
  activeService = null
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qn-mobile-service-'))
  tempDirs.push(dir)
  return dir
}

function createService(userData: string): MobileService {
  activeService = new MobileService({
    userData,
    router,
    cipher,
    desktopName: 'TestDesktop',
    version: '0.0.1',
  })
  return activeService
}

describe('MobileService', () => {
  it('生成设置视图、保存加密密码并生成可解析的连接信息', async () => {
    const userData = await tempDir()
    const service = createService(userData)
    await service.start()

    const initial = await service.getSettings()
    expect(initial.enabled).toBe(false)
    expect(initial.hasPassword).toBe(false)
    expect(initial.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(initial.running).toBe(false)
    expect(Array.isArray(initial.lanAddresses)).toBe(true)

    const saved = await service.saveSettings({
      password: 'Pair.Code!',
      publicAddresses: ['frp.example.com:7001', '[::1]:7002'],
    })
    expect(saved.hasPassword).toBe(true)
    expect(saved.publicAddresses).toEqual(['frp.example.com:7001', '[::1]:7002'])
    const settingsRaw = await readFile(join(mobileDirectory(userData), 'settings.json'), 'utf8')
    const secretsRaw = await readFile(join(userData, 'secrets.json'), 'utf8')
    expect(settingsRaw).not.toContain('Pair.Code!')
    expect(secretsRaw).not.toContain('Pair.Code!')

    const info = await service.connectionInfo({ address: 'frp.example.com:7001' })
    expect(info.text).toContain('电脑：TestDesktop')
    expect(info.text).toContain('地址：frp.example.com:7001')
    expect(parsePairingLink(info.link)).toEqual({
      host: 'frp.example.com',
      port: 7001,
      fp: initial.fingerprint,
      name: 'TestDesktop',
      code: 'Pair.Code!',
    })
    await expect(service.connectionInfo({ address: 'bad.example.com:7001' })).rejects.toThrow()
  })

  it('重新生成证书会更换指纹并撤销全部设备', async () => {
    const userData = await tempDir()
    const service = createService(userData)
    await service.start()
    const before = await service.getSettings()

    const external = new DeviceStore(deviceFilePath(mobileDirectory(userData)))
    await external.add({ name: '手机', ip: '127.0.0.1' })
    expect(await service.devices()).toHaveLength(1)

    const result = await service.regenerateCert()
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(result.fingerprint).not.toBe(before.fingerprint)
    expect((await service.getSettings()).fingerprint).toBe(result.fingerprint)
    expect(await new DeviceStore(deviceFilePath(mobileDirectory(userData))).list()).toEqual([])
  })

  it('按 id 撤销设备', async () => {
    const userData = await tempDir()
    const service = createService(userData)
    await service.start()
    const external = new DeviceStore(deviceFilePath(mobileDirectory(userData)))
    const { device } = await external.add({ name: '手机 A', ip: '127.0.0.1' })
    await external.add({ name: '手机 B', ip: '127.0.0.1' })

    await service.revokeDevice({ id: device.id })
    const remaining = await service.devices()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.name).toBe('手机 B')
    expect(() => service.revokeDevice({ id: '' })).toThrow()
  })
})
