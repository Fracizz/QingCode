import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const PAIR_FAILURE_LIMIT = 5
export const PAIR_FAILURE_WINDOW_MS = 60_000
export const PAIR_LOCK_MS = 60_000

export type PairFailureState = {
  count: number
  lockedUntil: number
  updatedAt: number
}

export type MobileDeviceRecord = {
  id: string
  name: string
  tokenHash: string
  pairedAt: number
  lastSeenAt: number
  lastIp: string
}

export type MobileDevice = Omit<MobileDeviceRecord, 'tokenHash'>

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const HASH_64 = /^[0-9a-f]{64}$/i

/** 令牌只在配对响应中出现一次；持久化前先转成定长摘要，比较时也保持常量时间。 */
export function newPairingToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** 锁定到期或两次失败间隔过长都视为新一轮连续失败。 */
export function normalizePairFailure(
  state: PairFailureState | undefined,
  now: number
): PairFailureState | undefined {
  if (!state) return undefined
  if (state.lockedUntil > now) return state
  if (state.lockedUntil > 0 || now - state.updatedAt >= PAIR_FAILURE_WINDOW_MS) return undefined
  return state
}

export function isPairLocked(state: PairFailureState | undefined, now: number): boolean {
  const active = normalizePairFailure(state, now)
  return active !== undefined && active.lockedUntil > now
}

export function recordPairFailure(
  state: PairFailureState | undefined,
  now: number,
  lockMs = PAIR_LOCK_MS
): PairFailureState {
  const active = normalizePairFailure(state, now)
  if (active && active.lockedUntil > now) return active
  const count = (active?.count ?? 0) + 1
  return {
    count,
    updatedAt: now,
    lockedUntil: count >= PAIR_FAILURE_LIMIT ? now + lockMs : 0,
  }
}

export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return '手机'
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  return value || '手机'
}

export function makePairedDevice(input: {
  name: unknown
  ip: string
  now: number
  token?: string
  id?: string
}): { token: string; device: MobileDeviceRecord } {
  const token = input.token ?? newPairingToken()
  return {
    token,
    device: {
      id: input.id ?? randomUUID(),
      name: cleanDeviceName(input.name),
      tokenHash: hashToken(token),
      pairedAt: input.now,
      lastSeenAt: input.now,
      lastIp: input.ip || 'unknown',
    },
  }
}

export function publicDevice(device: MobileDeviceRecord): MobileDevice {
  return {
    id: device.id,
    name: device.name,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    lastIp: device.lastIp,
  }
}

export function parseDeviceRecords(raw: unknown): MobileDeviceRecord[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.devices)
      ? raw.devices
      : []
  const result: MobileDeviceRecord[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const { id, name, tokenHash, pairedAt, lastSeenAt, lastIp } = item
    if (typeof id !== 'string' || id === '' || typeof name !== 'string') continue
    if (typeof tokenHash !== 'string' || !HASH_64.test(tokenHash)) continue
    if (typeof pairedAt !== 'number' || !Number.isFinite(pairedAt)) continue
    if (typeof lastSeenAt !== 'number' || !Number.isFinite(lastSeenAt)) continue
    result.push({
      id,
      name,
      tokenHash: tokenHash.toLowerCase(),
      pairedAt,
      lastSeenAt,
      lastIp: typeof lastIp === 'string' ? lastIp : '',
    })
  }
  return result
}

/** devices.json 的读写串行化，避免事件心跳与 RPC 同时更新 lastSeenAt 时互相覆盖。 */
export class DeviceStore {
  private cache: MobileDeviceRecord[] | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async load(): Promise<MobileDeviceRecord[]> {
    if (this.cache) return [...this.cache]
    let parsed: unknown = []
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
    } catch {
      // 文件缺失或损坏等价于尚未配对设备。
    }
    this.cache = parseDeviceRecords(parsed)
    return [...this.cache]
  }

  private async commit(devices: MobileDeviceRecord[]): Promise<void> {
    this.cache = [...devices]
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(devices, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }

  private exclusive<T>(fn: (devices: MobileDeviceRecord[]) => Promise<T> | T): Promise<T> {
    const task = this.queue.catch(() => undefined).then(async () => fn(await this.load()))
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  async list(): Promise<MobileDevice[]> {
    return this.exclusive((devices) =>
      [...devices]
        .sort((a, b) => b.pairedAt - a.pairedAt)
        .map(publicDevice)
    )
  }

  async add(input: { name: unknown; ip: string; now?: number; token?: string }): Promise<{
    token: string
    device: MobileDevice
  }> {
    return this.exclusive(async (devices) => {
      const created = makePairedDevice({
        name: input.name,
        ip: input.ip,
        now: input.now ?? this.now(),
        ...(input.token ? { token: input.token } : {}),
      })
      await this.commit([...devices, created.device])
      return { token: created.token, device: publicDevice(created.device) }
    })
  }

  /** 全表比较而不提前返回，避免令牌摘要的命中位置泄漏时间信息。 */
  async authenticate(token: string, ip: string, now = this.now()): Promise<MobileDevice | null> {
    const presented = hashToken(token.toLowerCase())
    return this.exclusive(async (devices) => {
      let matchIndex = -1
      for (let index = 0; index < devices.length; index += 1) {
        const device = devices[index]
        if (!device) continue
        if (constantTimeEqual(presented, device.tokenHash) && matchIndex < 0) matchIndex = index
      }
      const matched = matchIndex >= 0 ? devices[matchIndex] : undefined
      if (!matched) return null
      const updated: MobileDeviceRecord = { ...matched, lastSeenAt: now, lastIp: ip }
      const next = [...devices]
      next[matchIndex] = updated
      await this.commit(next)
      return publicDevice(updated)
    })
  }

  async touch(id: string, ip: string, now = this.now()): Promise<boolean> {
    return this.exclusive(async (devices) => {
      const index = devices.findIndex((device) => device.id === id)
      const matched = index >= 0 ? devices[index] : undefined
      if (!matched) return false
      const next = [...devices]
      next[index] = { ...matched, lastSeenAt: now, lastIp: ip }
      await this.commit(next)
      return true
    })
  }

  async revoke(id: string): Promise<boolean> {
    return this.exclusive(async (devices) => {
      const next = devices.filter((device) => device.id !== id)
      if (next.length === devices.length) return false
      await this.commit(next)
      return true
    })
  }

  async revokeAll(): Promise<void> {
    return this.exclusive(async () => {
      await this.commit([])
    })
  }
}

export function deviceFilePath(directory: string): string {
  return join(directory, 'devices.json')
}
