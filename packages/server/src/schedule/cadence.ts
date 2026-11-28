import type { ScheduleCadence } from '@qn/protocol'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export function parseCadence(value: unknown): ScheduleCadence | null {
  if (!value || typeof value !== 'object') return null
  const { frequency, time, timeZone, weekday } = value as Partial<ScheduleCadence>
  if (frequency !== 'daily' && frequency !== 'weekdays' && frequency !== 'weekly') return null
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) return null
  if (frequency === 'weekly' && (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return { frequency, time, timeZone, ...(frequency === 'weekly' ? { weekday } : {}) }
  } catch {
    return null
  }
}

export function nextScheduleAt(cadence: ScheduleCadence, after: number): number {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: cadence.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const wallTime = (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, Number(value)]))
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!)
  }
  const firstDay = Math.floor(wallTime(after) / DAY) * DAY
  const [hour, minute] = cadence.time.split(':').map(Number)
  for (let day = firstDay; day <= firstDay + 21 * DAY; day += DAY) {
    const weekday = new Date(day).getUTCDay()
    if (cadence.frequency === 'weekdays' && (weekday === 0 || weekday === 6)) continue
    if (cadence.frequency === 'weekly' && weekday !== cadence.weekday) continue
    const desired = day + (hour! * 60 + minute!) * MINUTE
    // DST 回拨时同一个墙钟时间只取第一次，春季跳过的时间没有匹配项。
    const offsets = new Set([desired - DAY, desired, desired + DAY].map((sample) => wallTime(sample) - sample))
    const first = Math.min(...[...offsets].map((offset) => desired - offset).filter((candidate) => wallTime(candidate) === desired))
    if (Number.isFinite(first) && first > after) return first
  }
  throw new Error('无法计算定时任务的下次运行时间')
}
