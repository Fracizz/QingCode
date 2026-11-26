import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n } from '../lib/i18n'
import { safeInvoke } from '../lib/tauri'
import {
  formatMetricBytes,
  memoryPercent,
  parseRemoteSystemMetrics,
  readRemoteMetricsInterval,
  REMOTE_METRICS_INTERVALS,
  usageLevel,
  writeRemoteMetricsInterval,
  type RemoteMetricsInterval,
  type RemoteSystemMetrics,
} from '../lib/remoteSystemMetrics'
import SettingSelect from './SettingSelect'
import Tooltip from './Tooltip'

const BAR_COLOR = { ok: 'bg-accent', warn: 'bg-warn', danger: 'bg-danger' } as const

/** 远程连接概览中的 CPU / 内存配置与实时占用；按所选频率轮询，窗口隐藏时暂停。 */
export default function RemoteSystemMetricsPanel({ rootUri }: { rootUri: string }) {
  const { t } = useI18n()
  const [interval, setIntervalValue] = useState<RemoteMetricsInterval>(readRemoteMetricsInterval)
  const [metrics, setMetrics] = useState<RemoteSystemMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sample = async () => {
      clearTimeout(timer)
      if (document.visibilityState === 'hidden') return
      setLoading(true)
      try {
        const value = parseRemoteSystemMetrics(
          await safeInvoke('读取远端系统指标', 'ssh_server_system_metrics', { rootUri })
        )
        if (disposed) return
        if (value) {
          setMetrics(value)
          setError(null)
        } else setError('远端返回的系统指标无效')
      } catch (cause) {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      if (disposed) return
      setLoading(false)
      if (interval > 0) timer = setTimeout(() => void sample(), interval * 1000)
    }
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') void sample()
      else clearTimeout(timer)
    }
    void sample()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [rootUri, interval, refreshToken])

  const intervalOptions = REMOTE_METRICS_INTERVALS.map(value => ({
    value: String(value),
    label: value === 0 ? t('手动刷新') : t('每 {seconds} 秒', { seconds: value }),
  }))
  const memory = metrics ? memoryPercent(metrics.memoryUsed, metrics.memoryTotal) : 0

  return (
    <div className="min-w-0" aria-busy={loading && !metrics}>
      <dt className="mb-1 flex min-w-0 items-center justify-between gap-2">
        <span className="text-ui-sm text-dialog-label">{t('系统资源')}</span>
        <span className="flex flex-shrink-0 items-center gap-1">
          <SettingSelect
            menuZIndex={135}
            aria-label={t('采集频率')}
            value={String(interval)}
            options={intervalOptions}
            onChange={value => {
              const next = Number(value) as RemoteMetricsInterval
              writeRemoteMetricsInterval(next)
              setIntervalValue(next)
            }}
          />
          <Tooltip label={t('立即刷新')} side="bottom">
            <button
              type="button"
              aria-label={t('立即刷新')}
              className="icon-btn"
              disabled={loading}
              onClick={() => setRefreshToken(value => value + 1)}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden />
            </button>
          </Tooltip>
        </span>
      </dt>
      <dd className="space-y-2.5">
        {metrics ? (
          <>
            {/* 配置只显示核心数、标称主频与内存总量，占用率随采集频率刷新。 */}
            <MetricRow
              label={[
                t('CPU · {cores} 核', { cores: metrics.cpuCores ?? metrics.cpuThreads }),
                metrics.cpuBaseMhz ? `${(metrics.cpuBaseMhz / 1000).toFixed(2)} GHz` : null,
              ].filter(Boolean).join(' · ')}
              percent={metrics.cpuUsage}
              value={`${metrics.cpuUsage.toFixed(1)}%`}
            />
            <MetricRow
              label={t('内存 · {total}', { total: formatMetricBytes(metrics.memoryTotal) })}
              percent={memory}
              value={`${memory.toFixed(1)}%`}
            />
          </>
        ) : (
          !error && <p className="text-ui-sm text-fg-muted">{t('正在读取系统指标…')}</p>
        )}
        {error && (
          <p role="status" className="break-words text-ui-sm text-warn [overflow-wrap:anywhere]">
            {t(error)}
          </p>
        )}
      </dd>
    </div>
  )
}

function MetricRow({ label, percent, value }: { label: string; percent: number; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-ui-sm">
        <span className="text-fg">{label}</span>
        <span className="font-mono tabular-nums text-fg">{value}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-hover"
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-300 ${BAR_COLOR[usageLevel(percent)]}`}
          style={{ width: `${Math.max(1, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  )
}
