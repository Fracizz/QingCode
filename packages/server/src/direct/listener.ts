import { createHash, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { generate } from 'selfsigned'
import { AuthLimiter } from './authLimiter'
import { isAllowedPeer, normalizeRemoteAddress } from './netPolicy'
import { directFiles, matchGrant, readConfig, readGrants, type DirectConfig, type DirectGrant } from './store'

// daemon 内置的 TLS 直连监听。监听本身随 daemon 常驻（SSH 只负责安装与开启），
// 配置与授权落盘，`direct.reload` 时重读；证书长期固定，客户端按指纹校验。

export type ListenAddress = { host: string; port: number }

export function parseListen(raw: string): ListenAddress {
  const text = raw.trim()
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(text) ?? /^()()(\d+)$/.exec(text)
  if (!m) throw new Error(`--listen 格式应为 host:port 或 port: ${raw}`)
  const port = Number(m[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口无效: ${m[3]}`)
  const host = m[1] ?? m[2] ?? ''
  return { host: host === '' ? '0.0.0.0' : host, port }
}

/** 连接码里给出的候选地址：监听具体地址时只给它，否则列出非内部 IPv4。 */
export function candidateHosts(
  listenHost: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  if (listenHost !== '0.0.0.0' && listenHost !== '::') return [listenHost]
  const hosts: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal && !hosts.includes(item.address)) hosts.push(item.address)
    }
  }
  return hosts
}

export function certFingerprint(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

export interface ServeCert {
  cert: string
  key: string
  fingerprint: string
}

/** 首次生成后复用；删除 <stateDir>/tls 即可轮换（所有客户端需重新导入）。 */
export async function loadOrCreateCert(stateDir: string): Promise<ServeCert> {
  const dir = path.join(stateDir, 'tls')
  const certFile = path.join(dir, 'cert.pem')
  const keyFile = path.join(dir, 'key.pem')
  try {
    const cert = fs.readFileSync(certFile, 'utf8')
    const key = fs.readFileSync(keyFile, 'utf8')
    return { cert, key, fingerprint: certFingerprint(cert) }
  } catch {
    // 缺失或损坏时重新生成。
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const pems = await generate([{ name: 'commonName', value: `qingcode-next ${os.hostname()}` }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - 60_000),
    notAfterDate: new Date(now + TEN_YEARS_MS),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  })
  for (const [file, content] of [[keyFile, pems.private], [certFile, pems.cert]] as const) {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  return { cert: pems.cert, key: pems.private, fingerprint: certFingerprint(pems.cert) }
}

export interface DirectStatus {
  enabled: boolean
  listening: boolean
  listen?: string
  allowPublic?: boolean
  fingerprint?: string
  grants: Array<Omit<DirectGrant, 'tokenSha256'>>
  error?: string
}

export interface DirectAuthorizer {
  /** 返回授权 id；失败返回 null（已计入限速）。 */
  authorize(token: unknown, peer: string): string | null
  isLocked(peer: string): boolean
}

export interface DirectListenerOptions {
  stateDir: string
  log(message: string): void
  /** 已通过来源检查的 TLS 连接交给 daemon 走统一的 hello/会话流程。 */
  onSocket(socket: tls.TLSSocket, peer: string): void
  /** 授权被撤销后，daemon 断开使用这些授权的会话。 */
  onRevoked(grantIds: Set<string>): void
}

export class DirectListener implements DirectAuthorizer {
  private server: tls.Server | null = null
  private current: { listen: string; allowPublic: boolean } | null = null
  private grants: DirectGrant[] = []
  private cert: ServeCert | null = null
  private lastError: string | undefined
  private readonly limiter = new AuthLimiter()
  private readonly files

  constructor(private readonly options: DirectListenerOptions) {
    this.files = directFiles(options.stateDir)
  }

  get listening(): boolean {
    return this.server !== null
  }

  /** 重读配置与授权并使监听状态与之一致；失败不抛出，记录在 status.error。 */
  async reload(): Promise<DirectStatus> {
    const previous = new Set(this.grants.map((g) => g.id))
    this.grants = readGrants(this.files)
    const kept = new Set(this.grants.map((g) => g.id))
    const revoked = new Set([...previous].filter((id) => !kept.has(id)))
    if (revoked.size > 0) this.options.onRevoked(revoked)

    const config = readConfig(this.files)
    try {
      await this.apply(config)
      this.lastError = undefined
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.options.log(`直连监听失败: ${this.lastError}`) // i18n-ignore: 仅进日志
    }
    return this.status()
  }

  status(): DirectStatus {
    const config = readConfig(this.files)
    return {
      enabled: config !== null,
      listening: this.server !== null,
      ...(config ? { listen: config.listen, allowPublic: config.allowPublic } : {}),
      ...(this.cert ? { fingerprint: this.cert.fingerprint } : {}),
      grants: this.grants.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  authorize(token: unknown, peer: string): string | null {
    const grant = matchGrant(this.grants, token)
    if (!grant) {
      this.limiter.fail(peer)
      return null
    }
    this.limiter.succeed(peer)
    return grant.id
  }

  isLocked(peer: string): boolean {
    return this.limiter.isLocked(peer)
  }

  async close(): Promise<void> {
    await this.stop()
  }

  private async apply(config: DirectConfig | null): Promise<void> {
    if (!config) {
      await this.stop()
      return
    }
    if (this.server && this.current?.listen === config.listen) {
      this.current = { listen: config.listen, allowPublic: config.allowPublic }
      return
    }
    await this.stop()
    const address = parseListen(config.listen)
    this.cert = await loadOrCreateCert(this.options.stateDir)
    const server = tls.createServer({ cert: this.cert.cert, key: this.cert.key, minVersion: 'TLSv1.2' })
    // 来源检查放在 TCP 层：被拒的地址连 TLS 握手都不做。
    server.on('connection', (raw) => {
      const peer = normalizeRemoteAddress(raw.remoteAddress ?? '')
      const allowPublic = this.current?.allowPublic ?? false
      if (!isAllowedPeer(peer, allowPublic)) {
        this.options.log(`直连拒绝公网来源 ${peer}（需要 --allow-public）`) // i18n-ignore: 仅进日志
        raw.destroy()
        return
      }
      if (this.limiter.isLocked(peer)) {
        raw.destroy()
      }
    })
    server.on('secureConnection', (socket) => {
      const peer = normalizeRemoteAddress(socket.remoteAddress ?? '')
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 30_000)
      this.options.onSocket(socket, peer)
    })
    server.on('tlsClientError', (err) => this.options.log(`直连 TLS 握手失败: ${err.message}`)) // i18n-ignore: 仅进日志
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address.port, address.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (err) => this.options.log(`直连监听错误: ${err.message}`)) // i18n-ignore: 仅进日志
    this.server = server
    this.current = { listen: config.listen, allowPublic: config.allowPublic }
    this.options.log(`直连监听 ${address.host}:${String(address.port)}，指纹 ${this.cert.fingerprint}`) // i18n-ignore: 仅进日志
  }

  private stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.current = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }
}
