/** 远端主机 CPU / 内存指标：解析、格式化与采集频率偏好。 */

export type RemoteSystemMetrics = {
  cpuThreads: number
  cpuCores: number | null
  /** 标称主频（MHz），配置值而非实时频率。 */
  cpuBaseMhz: number | null
  cpuUsage: number
  memoryTotal: number
  memoryUsed: number
}

/** 采集间隔（秒）；0 表示暂停自动采集，仅在打开时取一次。 */
export const REMOTE_METRICS_INTERVALS = [0, 2, 5, 10, 30, 60] as const
export type RemoteMetricsInterval = (typeof REMOTE_METRICS_INTERVALS)[number]
export const DEFAULT_REMOTE_METRICS_INTERVAL: RemoteMetricsInterval = 5
const INTERVAL_KEY = 'qingcode.remoteMetricsInterval'

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function parseRemoteSystemMetrics(value: unknown): RemoteSystemMetrics | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const memoryTotal = finite(raw.memoryTotal)
  const cpuThreads = finite(raw.cpuThreads)
  if (!memoryTotal || !cpuThreads) return null
  return {
    cpuThreads,
    cpuCores: finite(raw.cpuCores) || null,
    cpuBaseMhz: finite(raw.cpuBaseMhz) || null,
    cpuUsage: Math.min(100, finite(raw.cpuUsage) ?? 0),
    memoryTotal,
    memoryUsed: Math.min(memoryTotal, finite(raw.memoryUsed) ?? 0),
  }
}

/** 按 1024 进制格式化字节数，保留一位小数（GB 以上）。 */
export function formatMetricBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit >= 3 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`
}

export function memoryPercent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 1000) / 10 : 0
}

/** 占用率着色等级：≥90 危险，≥70 警告。 */
export function usageLevel(percent: number): 'ok' | 'warn' | 'danger' {
  return percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok'
}

export function readRemoteMetricsInterval(): RemoteMetricsInterval {
  try {
    const value = Number(localStorage.getItem(INTERVAL_KEY))
    if (localStorage.getItem(INTERVAL_KEY) !== null && (REMOTE_METRICS_INTERVALS as readonly number[]).includes(value)) {
      return value as RemoteMetricsInterval
    }
  } catch { /* localStorage 不可用时使用默认值 */ }
  return DEFAULT_REMOTE_METRICS_INTERVAL
}

export function writeRemoteMetricsInterval(value: RemoteMetricsInterval): void {
  try {
    localStorage.setItem(INTERVAL_KEY, String(value))
  } catch { /* 忽略持久化失败 */ }
}
