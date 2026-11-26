import { hostname, networkInterfaces } from 'node:os'
import { redactToken } from '../remoteCommands'
import { RouterError } from '../router'
import { defaultSecretCipher, type SecretCipher } from '../secretStore'
import type {
  MobileConnectionInfo,
  MobileDevice,
  MobileRegenerateResult,
  MobileSettings,
  MobileSettingsInput,
} from '../../shared/backendApi'
import { loadOrCreateCertificate, type MobileCertificate } from './cert'
import { MobileGateway, type RouterGateway } from './gateway'
import { buildConnectionInfo, formatAddress, parseAddress } from './link'
import { DeviceStore, deviceFilePath } from './pairing'
import {
  DEFAULT_MOBILE_SETTINGS,
  MobileSettingsStore,
  lanAddressesFromInterfaces,
  validateSettingsPatch,
  type MobileStoredSettings,
} from './settings'

export type MobileServiceOptions = {
  userData: string
  router: RouterGateway
  cipher?: SecretCipher
  desktopName?: string
  version?: string
  now?: () => number
  lockMs?: number
  heartbeatMs?: number
  bindHost?: string
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return redactToken(message).slice(0, 300) || '手机网关不可用'
}

function describeStartError(err: unknown, port: number): string {
  const code = err && typeof err === 'object' && 'code' in err
    ? (err as { code?: unknown }).code
    : undefined
  if (code === 'EADDRINUSE') return `端口 ${port} 已被占用`
  return describeError(err)
}

/** 统一串行化设置、证书、设备与监听器的变更，避免并发启停互相覆盖。 */
export class MobileService {
  private readonly userData: string
  private readonly ready: boolean
  private readonly desktopName: string
  private readonly settings: MobileSettingsStore
  private readonly deviceStore: DeviceStore
  private readonly gateway: MobileGateway
  private certificate: MobileCertificate | null = null
  private stateError: string | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: MobileServiceOptions) {
    this.userData = options.userData
    this.ready = options.userData.trim() !== ''
    this.desktopName = options.desktopName?.trim() || hostname().trim() || 'QingCode Next'
    this.settings = new MobileSettingsStore(options.userData, options.cipher ?? defaultSecretCipher())
    this.deviceStore = new DeviceStore(deviceFilePath(this.settings.directory), options.now)
    this.gateway = new MobileGateway({
      router: options.router,
      devices: this.deviceStore,
      getPairingCode: () => this.settings.getPassword(),
      desktopName: this.desktopName,
      version: options.version ?? '0.0.1',
      ...(options.now ? { now: options.now } : {}),
      ...(options.lockMs !== undefined ? { lockMs: options.lockMs } : {}),
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      ...(options.bindHost ? { bindHost: options.bindHost } : {}),
    })
  }

  async start(): Promise<void> {
    try {
      await this.enqueue(() => this.applySafely())
    } catch (err) {
      this.stateError = describeError(err)
    }
  }

  getSettings(): Promise<MobileSettings> {
    return this.enqueue(() => this.snapshot())
  }

  saveSettings(params: MobileSettingsInput): Promise<MobileSettings> {
    const patch = validateSettingsPatch(params)
    return this.enqueue(async () => {
      this.assertReady()
      const current = await this.settings.read()
      const next: MobileStoredSettings = {
        enabled: patch.enabled ?? current.enabled,
        port: patch.port ?? current.port,
        publicAddresses: patch.publicAddresses ?? current.publicAddresses,
      }
      if (patch.password !== undefined) await this.settings.setPassword(patch.password)
      await this.settings.write(next)
      await this.applySafely()
      return this.snapshot()
    })
  }

  connectionInfo(params: { address: string }): Promise<MobileConnectionInfo> {
    const address = typeof params?.address === 'string' ? params.address.trim() : ''
    if (!address) throw new RouterError('invalid_params', '请选择连接地址')
    return this.enqueue(async () => {
      this.assertReady()
      const parsed = parseAddress(address)
      if (!parsed || parsed.port === null) {
        throw new RouterError('invalid_params', '连接地址必须是有效的 host:port')
      }
      const canonical = formatAddress(parsed.host, parsed.port)
      const settings = await this.settings.read()
      const allowed = new Set(
        [
          ...settings.publicAddresses,
          ...lanAddressesFromInterfaces(networkInterfaces(), settings.port),
        ].map((value) => value.toLowerCase())
      )
      if (!allowed.has(canonical.toLowerCase())) {
        throw new RouterError('invalid_params', '请选择局域网地址或已添加的对外地址')
      }
      let code: string | null
      try {
        code = await this.settings.getPassword()
      } catch {
        throw new RouterError('unavailable', '无法读取配对密码，请在电脑上重新设置')
      }
      if (!code) throw new RouterError('pairing_unavailable', '请先设置配对密码')
      const certificate = await this.certificateNow()
      return buildConnectionInfo({
        host: parsed.host,
        port: parsed.port,
        fp: certificate.fingerprint,
        name: this.desktopName,
        code,
      })
    })
  }

  devices(): Promise<MobileDevice[]> {
    return this.enqueue(async () => {
      this.assertReady()
      return this.deviceStore.list()
    })
  }

  revokeDevice(params: { id: string }): Promise<void> {
    const id = typeof params?.id === 'string' ? params.id.trim() : ''
    if (!id) throw new RouterError('invalid_params', '设备 id 无效')
    return this.enqueue(async () => {
      this.assertReady()
      await this.deviceStore.revoke(id)
      this.gateway.disconnectDevice(id)
    })
  }

  regenerateCert(): Promise<MobileRegenerateResult> {
    return this.enqueue(async () => {
      this.assertReady()
      await this.deviceStore.revokeAll()
      this.gateway.disconnectAllDevices()
      const certificate = await this.regenerateCertificate()
      await this.applySafely()
      return { fingerprint: certificate.fingerprint }
    })
  }

  dispose(): Promise<void> {
    return this.enqueue(async () => {
      await this.gateway.stop()
    })
  }

  private assertReady(): void {
    if (!this.ready) throw new RouterError('unavailable', 'userData 路径未配置')
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => undefined).then(fn)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async certificateNow(): Promise<MobileCertificate> {
    this.assertReady()
    if (!this.certificate) {
      this.certificate = await loadOrCreateCertificate(this.settings.directory, {
        commonName: this.desktopName,
      })
    }
    return this.certificate
  }

  private async regenerateCertificate(): Promise<MobileCertificate> {
    this.assertReady()
    const certificate = await loadOrCreateCertificate(this.settings.directory, {
      replace: true,
      commonName: this.desktopName,
    })
    this.certificate = certificate
    return certificate
  }

  private async snapshot(): Promise<MobileSettings> {
    let settings: MobileStoredSettings = {
      ...DEFAULT_MOBILE_SETTINGS,
      publicAddresses: [],
    }
    let hasPassword = false
    if (this.ready) {
      settings = await this.settings.read()
      hasPassword = await this.settings.hasPassword()
      if (!this.certificate) {
        try {
          this.certificate = await this.certificateNow()
        } catch (err) {
          this.stateError ??= describeError(err)
        }
      }
    }
    return {
      enabled: settings.enabled,
      port: settings.port,
      hasPassword,
      publicAddresses: [...settings.publicAddresses],
      lanAddresses: lanAddressesFromInterfaces(networkInterfaces(), settings.port),
      fingerprint: this.certificate?.fingerprint ?? '',
      running: this.gateway.running,
      ...(this.stateError ? { error: this.stateError } : {}),
    }
  }

  private async applySafely(): Promise<void> {
    try {
      await this.applyNow()
    } catch (err) {
      this.stateError = describeError(err)
      await this.gateway.stop().catch(() => undefined)
    }
  }

  private async applyNow(): Promise<void> {
    const settings = await this.settings.read()
    const certificate = await this.certificateNow()
    if (!settings.enabled) {
      await this.gateway.stop()
      this.stateError = undefined
      return
    }
    let code: string | null
    try {
      code = await this.settings.getPassword()
    } catch {
      code = null
      this.stateError = '无法读取配对密码，请在电脑上重新设置'
      await this.gateway.stop()
      return
    }
    if (!code) {
      this.stateError = '请先设置配对密码'
      await this.gateway.stop()
      return
    }
    try {
      await this.gateway.start(settings.port, certificate)
      this.stateError = undefined
    } catch (err) {
      await this.gateway.stop().catch(() => undefined)
      this.stateError = describeStartError(err, settings.port)
    }
  }
}
