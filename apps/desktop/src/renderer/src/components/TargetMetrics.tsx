import { useEffect, useState } from 'react'
import { t } from '@qn/codex-client'
import type { ServerResult } from '@qn/protocol'
import { BackendCallError, call } from '../lib/backend'

type Metrics = ServerResult<'system.metrics'>
const POLL_MS = 5_000

function parseMetrics(result: unknown): Metrics | null {
  if (!result || typeof result !== 'object') return null
  const { cpuThreads, cpuUsage, memoryUsed, memoryTotal } = result as Partial<Metrics>
  if (typeof cpuThreads !== 'number' || !Number.isSafeInteger(cpuThreads) || cpuThreads < 0 ||
      (cpuUsage !== null && (typeof cpuUsage !== 'number' || !Number.isFinite(cpuUsage) || cpuUsage < 0 || cpuUsage > 100)) ||
      typeof memoryUsed !== 'number' || !Number.isSafeInteger(memoryUsed) ||
      typeof memoryTotal !== 'number' || !Number.isSafeInteger(memoryTotal) ||
      memoryTotal <= 0 || memoryUsed < 0 || memoryUsed > memoryTotal) return null
  return { cpuThreads, cpuUsage, memoryUsed, memoryTotal }
}

function usageClass(percent: number | null): string {
  if (percent === null) return ''
  if (percent >= 90) return 'text-qn-danger'
  if (percent >= 70) return 'text-qn-warn'
  return ''
}

export function TargetMetrics({ targetId }: { targetId: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)

  useEffect(() => {
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function refresh() {
      clearTimeout(timer)
      if (stopped || document.hidden || inFlight) return
      inFlight = true
      try {
        const result = await call('server.req', { targetId, method: 'system.metrics' })
        if (!stopped) setMetrics(parseMetrics(result))
      } catch (err) {
        if (!stopped) setMetrics(null)
        // 旧 daemon 没有这个方法，重连或回到对话后再探测。
        if (err instanceof BackendCallError && err.code === 'method') stopped = true
      } finally {
        inFlight = false
        if (!stopped && !document.hidden) timer = setTimeout(refresh, POLL_MS)
      }
    }

    const onVisibility = () => void refresh()
    document.addEventListener('visibilitychange', onVisibility)
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [targetId])

  if (!metrics) return null
  const { cpuThreads, cpuUsage, memoryUsed, memoryTotal } = metrics
  const memoryPercent = 100 * memoryUsed / memoryTotal
  // 已用和总量统一使用同一个单位，便于直接比较。
  const unit = memoryTotal >= 1024 ** 3 ? 'GiB' : 'MiB'
  const scale = unit === 'GiB' ? 1024 ** 3 : 1024 ** 2
  const size = (bytes: number) => (bytes / scale).toFixed(1).replace(/\.0$/, '')
  const capacity = `${size(memoryUsed)}/${size(memoryTotal)} ${unit}`
  const cpuPercent = cpuUsage === null ? '—' : `${cpuUsage.toFixed(1)}%`
  const memoryPercentLabel = `${memoryPercent.toFixed(1)}%`

  return (
    <span className="flex shrink-0 items-center gap-3 whitespace-nowrap text-ui-xs text-qn-muted tabular-nums">
      <span title={cpuThreads > 0 ? t('CPU 占用率 · {count} 个逻辑核心', { count: cpuThreads }) : t('CPU 占用率')}>
        CPU <span className={usageClass(cpuUsage)}>{cpuPercent}</span>
      </span>
      <span title={t('内存已用 {capacity} · {percent}', { capacity, percent: memoryPercentLabel })}>
        {t('内存')}{' '}
        <span className={usageClass(memoryPercent)}>
          <span className="@max-[26rem]:hidden">{capacity}</span>
          <span className="hidden @max-[26rem]:inline">{memoryPercentLabel}</span>
        </span>
      </span>
    </span>
  )
}
