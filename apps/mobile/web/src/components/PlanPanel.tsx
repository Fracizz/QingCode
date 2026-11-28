import { t, type PlanView } from '@qn/codex-client'
import { Check, Circle, CircleDot } from 'lucide-react'
import { LoadingIcon } from './ui'

/** 当前会话最新的计划 / TODO 清单步骤，显示在状态胶囊打开的弹层里。 */
export function PlanSteps({ plan, running }: {
  plan: PlanView
  /** 轮次运行中时，进行中的步骤显示转圈。 */
  running: boolean
}) {
  return (
    <>
      {plan.explanation && <p className="mb-2 text-xs text-qn-muted wrap-anywhere">{plan.explanation}</p>}
      <ol>
        {plan.steps.map((item, index) => (
          <li key={index} className="flex items-start gap-2.5 py-2 text-sm">
            <span className="mt-0.5 shrink-0" role="img"
              aria-label={item.status === 'completed' ? t('已完成') : item.status === 'inProgress' ? t('进行中') : t('未开始')}>
              {item.status === 'completed' ? <Check size={15} className="text-qn-ok" />
                : item.status === 'inProgress' ? (running ? <LoadingIcon size={15} /> : <CircleDot size={15} className="text-qn-accent" />)
                  : <Circle size={15} className="text-qn-dim" />}
            </span>
            <span className={`min-w-0 wrap-anywhere ${item.status === 'completed' ? 'text-qn-muted line-through' : 'text-qn-text'}`}>
              {item.step}
            </span>
          </li>
        ))}
      </ol>
    </>
  )
}
