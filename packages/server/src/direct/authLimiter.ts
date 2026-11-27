// 直连鉴权失败按来源 IP 计数：连续 N 次失败锁定一段时间（与手机网关同一策略）。

export interface AuthLimiterOptions {
  maxFailures?: number
  lockMs?: number
  now?: () => number
}

interface Entry {
  failures: number
  lockedUntil: number
}

export class AuthLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly maxFailures: number
  private readonly lockMs: number
  private readonly now: () => number

  constructor(options: AuthLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5
    this.lockMs = options.lockMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  isLocked(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    if (entry.lockedUntil > this.now()) return true
    if (entry.lockedUntil !== 0) this.entries.delete(key)
    return false
  }

  fail(key: string): void {
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 }
    entry.failures += 1
    if (entry.failures >= this.maxFailures) {
      entry.failures = 0
      entry.lockedUntil = this.now() + this.lockMs
    }
    this.entries.set(key, entry)
    // 防止被大量来源撑爆内存：只保留最近的一批。
    if (this.entries.size > 4096) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  succeed(key: string): void {
    this.entries.delete(key)
  }
}
