import { useState } from 'react'
import { Check, ChevronRight, Circle, CircleDot, ListChecks } from 'lucide-react'
import { planProgress, t, type PlanView } from '@qn/codex-client'
import { cn } from '../lib/cn'
import { LoadingIcon } from './LoadingIcon'

/** 当前会话最新的计划 / TODO 清单，默认收起只显示进度与当前步骤。 */
export function PlanPanel({ plan, running, contentWidthClassName = 'max-w-3xl' }: {
  plan: PlanView | undefined
  /** 轮次运行中时，进行中的步骤显示转圈。 */
  running: boolean
  contentWidthClassName?: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (!plan?.steps.length) return null
  const { done, total, current } = planProgress(plan)
  return (
    <div className="shrink-0 px-6 pb-1">
      <section
        aria-label={t('任务清单')}
        className={cn('mx-auto rounded-lg border border-qn-border bg-qn-panel px-3 py-1.5 text-ui-sm', contentWidthClassName)}
      >
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-h-6 w-full items-center gap-1.5 rounded-md text-left text-qn-muted outline-none hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover"
          onClick={() => setExpanded((value) => !value)}
        >
          <ListChecks size={14} className="shrink-0" aria-hidden />
          <span className="shrink-0">{t('任务清单 {done}/{total}', { done, total })}</span>
          <span className="min-w-0 flex-1 truncate text-qn-text">{!expanded && (current?.step ?? t('全部完成'))}</span>
          <ChevronRight size={14} className={cn('shrink-0 transition-transform', expanded && 'rotate-90')} aria-hidden />
        </button>
        {expanded && (
          <>
            {plan.explanation && <p className="wrap-anywhere pt-1 text-qn-muted">{plan.explanation}</p>}
            <ol className="qn-scroll mt-1 max-h-40 space-y-0.5 overflow-y-auto">
              {plan.steps.map((item, index) => (
                <li key={index} className="flex items-start gap-1.5 py-0.5">
                  <span className="mt-0.5 shrink-0" role="img"
                    aria-label={item.status === 'completed' ? t('已完成') : item.status === 'inProgress' ? t('进行中') : t('未开始')}>
                    {item.status === 'completed' ? <Check size={13} className="text-qn-ok" />
                      : item.status === 'inProgress' ? (running ? <LoadingIcon size={13} /> : <CircleDot size={13} className="text-qn-brand" />)
                        : <Circle size={13} className="text-qn-dim" />}
                  </span>
                  <span className={cn('min-w-0 wrap-anywhere', item.status === 'completed' ? 'text-qn-muted line-through' : 'text-qn-text')}>
                    {item.step}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </div>
  )
}
