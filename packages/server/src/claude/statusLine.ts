import os from 'node:os'
import path from 'node:path'
import { asRecord, finite } from './v2'

const PUBLISH_INTERVAL_MS = 15_000

type Window = { usedPercent: number; resetsAt: number; windowDurationMins: number }
type Windows<T = Window> = { primary: T | null; secondary: T | null }
type ObservedWindow = { window: Window; at: number }
const EMPTY: Windows<ObservedWindow> = { primary: null, secondary: null }

export function statusLineProfile(directory?: string): string {
  const resolved = path.resolve(directory || path.join(os.homedir(), '.claude'))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseWindow(value: unknown, windowDurationMins: number): Window | null {
  const row = asRecord(value)
  const usedPercent = finite(row?.used_percentage)
  const resetsAt = finite(row?.resets_at)
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100 || resetsAt === null || resetsAt <= 0) return null
  return { usedPercent, resetsAt, windowDurationMins }
}

/** 只传递 CLI 文档列出的两个订阅窗口，完整状态栏载荷留在本进程。 */
export function statusLineWindows(value: unknown): Windows {
  const limits = asRecord(value)
  return {
    primary: parseWindow(limits?.five_hour, 300),
    secondary: parseWindow(limits?.seven_day, 10_080),
  }
}

function active(reading: ObservedWindow | null, now: number): ObservedWindow | null {
  return reading && reading.window.resetsAt * 1000 > now ? reading : null
}

function newerWindow(before: ObservedWindow | null, after: ObservedWindow | null, now: number): ObservedWindow | null {
  before = active(before, now)
  after = active(after, now)
  if (!after) return before
  if (!before || after.window.resetsAt > before.window.resetsAt) return after
  // 同一窗口中旧终端的快照可能晚到，保留已知的较新读数。
  return after.window.resetsAt === before.window.resetsAt && after.window.usedPercent > before.window.usedPercent ? after : before
}

function merge(before: Windows<ObservedWindow>, after: Windows<ObservedWindow>, now: number): Windows<ObservedWindow> {
  return {
    primary: newerWindow(before.primary, after.primary, now),
    secondary: newerWindow(before.secondary, after.secondary, now),
  }
}

/** 每个目标机配置目录各自节流，间隔内保留最后一次变化。 */
export class ClaudeStatusLine {
  private windows = EMPTY
  private pending: Windows<ObservedWindow> | null = null
  private nextPublishAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly onChange: () => void) {}

  snapshot(): Windows & { observedAt: number | null } {
    const { primary, secondary } = merge(this.windows, EMPTY, Date.now())
    return {
      primary: primary?.window ?? null,
      secondary: secondary?.window ?? null,
      observedAt: Math.max(primary?.at ?? 0, secondary?.at ?? 0) || null,
    }
  }

  ingest(value: unknown): void {
    const windows = statusLineWindows(value)
    if (!windows.primary && !windows.secondary) return
    const at = Date.now()
    this.pending = merge(this.pending ?? EMPTY, {
      primary: windows.primary && { window: windows.primary, at },
      secondary: windows.secondary && { window: windows.secondary, at },
    }, at)
    this.update()
  }

  close(): void {
    clearTimeout(this.timer)
  }

  private update(): void {
    clearTimeout(this.timer)
    const now = Date.now()
    let next = merge(this.windows, EMPTY, now)
    if (this.pending && now >= this.nextPublishAt) {
      next = merge(next, this.pending, now)
      this.pending = null
      if (next.primary !== this.windows.primary || next.secondary !== this.windows.secondary) {
        this.nextPublishAt = now + PUBLISH_INTERVAL_MS
      }
    }
    const changed = next.primary !== this.windows.primary || next.secondary !== this.windows.secondary
    this.windows = next
    const nextUpdate = Math.min(
      this.pending ? this.nextPublishAt : Infinity,
      next.primary ? next.primary.window.resetsAt * 1000 : Infinity,
      next.secondary ? next.secondary.window.resetsAt * 1000 : Infinity,
    )
    if (Number.isFinite(nextUpdate)) {
      this.timer = setTimeout(() => this.update(), Math.max(1, Math.min(2_147_483_647, nextUpdate - now)))
      this.timer.unref()
    }
    if (changed) this.onChange()
  }
}
