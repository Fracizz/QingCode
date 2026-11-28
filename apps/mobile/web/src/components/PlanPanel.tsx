import { planProgress, t, type PlanView } from '@qn/codex-client'
import { Check, Circle, CircleDot, ListChecks } from 'lucide-react'
import { LoadingIcon } from './ui'

/** 当前会话最新的计划 / TODO 清单，默认收起只显示进度与当前步骤。 */
export function PlanPanel({ plan, running }: {
  plan: PlanView | undefined
  /** 轮次运行中时，进行中的步骤显示转圈。 */
  running: boolean
}) {
  if (!plan?.steps.length) return null
  const { done, total, current } = planProgress(plan)
  return (
    <section className="qn-queue" aria-label={t('任务清单')}>
      <details className="qn-details qn-queue-details qn-plan">
        <summary>
          <ListChecks size={15} className="mr-1.5 shrink-0" aria-hidden />
          <span className="shrink-0">{t('任务清单 {done}/{total}', { done, total })}</span>
          <span className="qn-plan-current ml-2 min-w-0 flex-1 truncate text-qn-text">{current?.step ?? t('全部完成')}</span>
        </summary>
        {plan.explanation && <p className="mb-1 pr-2 text-xs text-qn-muted wrap-anywhere">{plan.explanation}</p>}
        <ol className="qn-scroll qn-queue-list">
          {plan.steps.map((item, index) => (
            <li key={index} className="flex items-start gap-2 py-1 pr-2 text-[13px]">
              <span className="mt-0.5 shrink-0" role="img"
                aria-label={item.status === 'completed' ? t('已完成') : item.status === 'inProgress' ? t('进行中') : t('未开始')}>
                {item.status === 'completed' ? <Check size={14} className="text-qn-ok" />
                  : item.status === 'inProgress' ? (running ? <LoadingIcon size={14} /> : <CircleDot size={14} className="text-qn-accent" />)
                    : <Circle size={14} className="text-qn-dim" />}
              </span>
              <span className={`min-w-0 wrap-anywhere ${item.status === 'completed' ? 'text-qn-muted line-through' : 'text-qn-text'}`}>
                {item.step}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  )
}
