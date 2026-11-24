import { SquareTerminal, Zap } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { ScopedPrewarmStatus } from '../hooks/usePrewarmStatuses'
import { safeInvoke } from '@/lib/tauri'
import { prewarmBadgeDetails, prewarmBadges } from '@/lib/terminal/prewarmBadge'
import InfoTipCard from './InfoTipCard'
import Tooltip from './Tooltip'

type Translate = (key: string, params?: Record<string, string | number>) => string

const TONE = {
  // 补满为绿色（可直接用），补充中退成辅助灰，暂停用警示色。
  full: 'text-ok',
  filling: 'text-term-list-meta',
  paused: 'text-warn',
} as const

/** 吞掉单击：徽标在主机标题按钮里，双击重试时不应顺带两次展开/收起分组。 */
const swallow = (event: MouseEvent) => event.stopPropagation()

/**
 * 主机分组标题上的「▣就绪/目标 ⚡就绪/目标」：普通 Shell 池与 CLI 池各自着色；
 * 悬停查看两个池的详情，双击清掉暂停/退避立即重新预热。预热未开启时不渲染。
 */
export default function PrewarmPoolBadge({
  hostKey,
  scoped,
  translate,
}: {
  hostKey: string
  scoped: ScopedPrewarmStatus | undefined
  translate: Translate
}) {
  const badges = prewarmBadges(scoped?.status)
  if (!scoped || badges.length === 0) return null
  const retry = (event: MouseEvent) => {
    event.stopPropagation()
    void safeInvoke('重新触发预热', 'shell_prewarm_retry', { cwd: scoped.cwd }).catch(() => undefined)
  }
  const labels = badges.map(badge => {
    const label = translate(badge.pool === 'cli' ? 'CLI 预热 {ready}/{target}' : 'Shell 预热 {ready}/{target}', {
      ready: badge.ready,
      target: badge.target,
    })
    return badge.reason ? `${label} · ${badge.reason}` : label
  })
  return (
    <Tooltip
      label={labels.join('，')}
      content={<InfoTipCard {...prewarmBadgeDetails(scoped.status, scoped.recent, translate)} />}
      side="top"
      wrapperClassName="flex shrink-0"
    >
      <span
        data-terminal-host-prewarm={hostKey}
        className="inline-flex items-center gap-1.5 text-ui-2xs font-medium leading-none tabular-nums"
        onClick={swallow}
        onDoubleClick={retry}
      >
        {badges.map(badge => {
          const Icon = badge.pool === 'cli' ? Zap : SquareTerminal
          return (
            <span
              key={badge.pool}
              role="img"
              aria-label={translate(badge.pool === 'cli' ? 'CLI 预热 {ready}/{target}' : 'Shell 预热 {ready}/{target}', {
                ready: badge.ready,
                target: badge.target,
              })}
              data-prewarm-tone={badge.tone}
              data-prewarm-pool={badge.pool}
              className={`inline-flex items-center gap-0.5 ${TONE[badge.tone]}`}
            >
              <Icon size={12} aria-hidden="true" />
              {badge.ready}/{badge.target}
            </span>
          )
        })}
      </span>
    </Tooltip>
  )
}
