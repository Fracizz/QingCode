import { Zap } from 'lucide-react'
import type { ScopedPrewarmStatus } from '../hooks/usePrewarmStatuses'
import { prewarmBadge, prewarmBadgeDetails } from '@/lib/terminal/prewarmBadge'
import InfoTipCard from './InfoTipCard'
import Tooltip from './Tooltip'

type Translate = (key: string, params?: Record<string, string | number>) => string

const TONE = {
  // 补满为绿色（可直接用），补充中退成辅助灰，暂停用警示色。
  full: 'text-ok',
  filling: 'text-term-list-meta',
  paused: 'text-warn',
} as const

/** 主机分组标题上的「⚡就绪/目标」；悬停查看两个池的详情。预热未开启时不渲染。 */
export default function PrewarmPoolBadge({
  hostKey,
  scoped,
  translate,
}: {
  hostKey: string
  scoped: ScopedPrewarmStatus | undefined
  translate: Translate
}) {
  const badge = prewarmBadge(scoped?.status)
  if (!scoped || !badge) return null
  const label = translate(badge.pool === 'cli' ? 'CLI 预热 {ready}/{target}' : 'Shell 预热 {ready}/{target}', {
    ready: badge.ready,
    target: badge.target,
  })
  return (
    <Tooltip
      label={badge.reason ? `${label} · ${badge.reason}` : label}
      content={<InfoTipCard {...prewarmBadgeDetails(scoped.status, scoped.recent, translate)} />}
      side="top"
      wrapperClassName="flex shrink-0"
    >
      <span
        role="img"
        aria-label={label}
        data-terminal-host-prewarm={hostKey}
        data-prewarm-tone={badge.tone}
        data-prewarm-pool={badge.pool}
        className={`inline-flex items-center gap-0.5 text-ui-2xs font-medium leading-none tabular-nums ${TONE[badge.tone]}`}
      >
        <Zap size={12} aria-hidden="true" />
        {badge.ready}/{badge.target}
      </span>
    </Tooltip>
  )
}
