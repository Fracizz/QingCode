import { describe, expect, it } from 'vitest'
import { formatTerminalAge, terminalLastActiveAt } from './terminalLastActive'

const t = (key: string, values?: Record<string, string | number>) =>
  values ? key.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name])) : key

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 9, 12)

describe('terminalLastActiveAt', () => {
  it('prefers the recorded activity, then the exit time, then the creation time', () => {
    expect(terminalLastActiveAt({ lastActiveAt: 30, endedAt: 20, createdAt: 10 })).toBe(30)
    expect(terminalLastActiveAt({ endedAt: 20, createdAt: 10 })).toBe(20)
    expect(terminalLastActiveAt({ createdAt: 10, startedAt: 5 })).toBe(10)
    expect(terminalLastActiveAt({ startedAt: 5 })).toBe(5)
  })

  it('ignores invalid values and returns null without any time', () => {
    expect(terminalLastActiveAt({ lastActiveAt: 0, createdAt: Number.NaN })).toBeNull()
    expect(terminalLastActiveAt({})).toBeNull()
  })
})

describe('formatTerminalAge', () => {
  it('uses compact units without the word 前', () => {
    expect(formatTerminalAge(NOW - 30_000, NOW, t)).toBe('刚刚')
    expect(formatTerminalAge(NOW - 5 * MINUTE, NOW, t)).toBe('5分钟')
    expect(formatTerminalAge(NOW - 3 * HOUR, NOW, t)).toBe('3小时')
    expect(formatTerminalAge(NOW - 4 * DAY, NOW, t)).toBe('4天')
    expect(formatTerminalAge(NOW - 65 * DAY, NOW, t)).toBe('2个月')
    expect(formatTerminalAge(NOW - 800 * DAY, NOW, t)).toBe('2年')
  })

  it('treats future timestamps as just now and invalid ones as missing', () => {
    expect(formatTerminalAge(NOW + 10_000, NOW, t)).toBe('刚刚')
    expect(formatTerminalAge(null, NOW, t)).toBeNull()
    expect(formatTerminalAge(-1, NOW, t)).toBeNull()
  })
})
