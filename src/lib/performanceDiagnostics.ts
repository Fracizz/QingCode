export type PerformanceThroughputKind = 'terminalBytes' | 'fsEvents'

export interface SlowTauriCommand {
  command: string
  durationMs: number
  succeeded: boolean
  at: number
}

export interface PerformanceDiagnosticsSnapshot {
  startedAt: number
  longTasks: {
    count: number
    totalDurationMs: number
    maxDurationMs: number
  }
  tauriCommands: {
    count: number
    slowCount: number
    maxDurationMs: number
    recentSlow: SlowTauriCommand[]
  }
  rates: {
    sampleWindowSeconds: number
    terminalBytesPerSecond: number
    fsEventsPerSecond: number
  }
}

type RateSample = {
  at: number
  terminalBytes: number
  fsEvents: number
}

const RATE_WINDOW_MS = 10_000
const SLOW_COMMAND_MS = 200
const MAX_RECENT_SLOW_COMMANDS = 30
const startedAt = Date.now()
const rateSamples: RateSample[] = []
const recentSlowCommands: SlowTauriCommand[] = []

let longTaskCount = 0
let longTaskTotalDurationMs = 0
let longTaskMaxDurationMs = 0
let commandCount = 0
let slowCommandCount = 0
let commandMaxDurationMs = 0
let installed = false

function pruneRateSamples(now: number): void {
  const cutoff = now - RATE_WINDOW_MS
  while (rateSamples.length > 0 && rateSamples[0].at < cutoff) rateSamples.shift()
}

export function recordPerformanceThroughput(
  kind: PerformanceThroughputKind,
  amount = 1
): void {
  if (!Number.isFinite(amount) || amount <= 0) return
  const now = Date.now()
  pruneRateSamples(now)
  const latest = rateSamples.at(-1)
  const sample = latest && now - latest.at < 250 ? latest : null
  const target = sample ?? { at: now, terminalBytes: 0, fsEvents: 0 }
  target[kind] += amount
  if (!sample) rateSamples.push(target)
}

export function recordTauriCommandDuration(
  command: string,
  durationMs: number,
  succeeded: boolean
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  commandCount += 1
  commandMaxDurationMs = Math.max(commandMaxDurationMs, durationMs)
  if (durationMs < SLOW_COMMAND_MS) return
  slowCommandCount += 1
  recentSlowCommands.push({ command, durationMs, succeeded, at: Date.now() })
  if (recentSlowCommands.length > MAX_RECENT_SLOW_COMMANDS) recentSlowCommands.shift()
}

export function recordLongTask(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  longTaskCount += 1
  longTaskTotalDurationMs += durationMs
  longTaskMaxDurationMs = Math.max(longTaskMaxDurationMs, durationMs)
}

export function getPerformanceDiagnosticsSnapshot(): PerformanceDiagnosticsSnapshot {
  const now = Date.now()
  pruneRateSamples(now)
  const totals = rateSamples.reduce(
    (sum, sample) => ({
      terminalBytes: sum.terminalBytes + sample.terminalBytes,
      fsEvents: sum.fsEvents + sample.fsEvents,
    }),
    { terminalBytes: 0, fsEvents: 0 }
  )
  const sampleWindowSeconds = Math.max(1, Math.min(RATE_WINDOW_MS, now - startedAt) / 1000)
  return {
    startedAt,
    longTasks: {
      count: longTaskCount,
      totalDurationMs: longTaskTotalDurationMs,
      maxDurationMs: longTaskMaxDurationMs,
    },
    tauriCommands: {
      count: commandCount,
      slowCount: slowCommandCount,
      maxDurationMs: commandMaxDurationMs,
      recentSlow: [...recentSlowCommands],
    },
    rates: {
      sampleWindowSeconds,
      terminalBytesPerSecond: totals.terminalBytes / sampleWindowSeconds,
      fsEventsPerSecond: totals.fsEvents / sampleWindowSeconds,
    },
  }
}

/** Install after first paint. Snapshot is available in DevTools as `__qingcodePerformanceDiagnostics`. */
export function installPerformanceDiagnostics(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const diagnosticsGlobal = globalThis as typeof globalThis & {
    __qingcodePerformanceDiagnostics?: () => PerformanceDiagnosticsSnapshot
  }
  diagnosticsGlobal.__qingcodePerformanceDiagnostics = getPerformanceDiagnosticsSnapshot

  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'longtask') recordLongTask(entry.duration)
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    // Older WebView2 versions may expose PerformanceObserver without longtask support.
  }
}
