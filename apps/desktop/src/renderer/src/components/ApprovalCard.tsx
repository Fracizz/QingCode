import { ListTodo, ShieldAlert } from 'lucide-react'
import type { ApprovalDecision, ApprovalView } from '@qn/codex-client'
import { t } from '@qn/codex-client'
import { ReplyMarkdown } from './MessageItem'
import { Badge } from './ui'
import { UserInputCard } from './UserInputCard'

export function ApprovalCard({
  approval,
  plan,
  onDecide,
  onAnswer,
}: {
  approval: ApprovalView
  /** 有值表示这是退出计划模式的审批，内容为完整计划（取不到时为空串）。 */
  plan?: string
  onDecide: (decision: ApprovalDecision) => void
  /** Agent 提问（item/tool/requestUserInput）的回答；提供时按问答卡片渲染。 */
  onAnswer?: (answers: Record<string, string[]>) => void
}) {
  if (approval.questions && approval.questions.length > 0 && onAnswer) {
    return <UserInputCard approval={approval} onSubmit={onAnswer} />
  }
  if (plan !== undefined) {
    return (
      <div className="rounded-xl border border-qn-border-strong bg-qn-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <ListTodo size={15} className="text-qn-accent" aria-hidden />
          <span className="text-ui-md font-medium">{t('计划待批准')}</span>
          <Badge tone="warn">{t('等待处理')}</Badge>
        </div>
        <div className="qn-scroll mb-2 max-h-[min(24rem,45vh)] overflow-auto rounded-lg border border-qn-border bg-qn-inset px-3 py-2 text-ui">
          {plan.trim() ? (
            <div className="qn-markdown min-w-0 wrap-anywhere text-qn-prose">
              <ReplyMarkdown text={plan} streaming={false} />
            </div>
          ) : <pre className="whitespace-pre-wrap break-words font-mono text-ui-sm leading-5">{approval.detail}</pre>}
        </div>
        <p className="mb-3 text-ui-sm text-qn-muted">{t('批准后退出计划模式并开始执行；继续规划则保持计划模式。')}</p>
        <div className="flex flex-wrap gap-2">
          <button className="qn-button" onClick={() => onDecide('accept')}>
            {t('批准计划')}
          </button>
          <button className="qn-button-subtle" onClick={() => onDecide('decline')}>
            {t('继续规划')}
          </button>
        </div>
      </div>
    )
  }
  const allows = (decision: ApprovalDecision) => !approval.decisions || approval.decisions.includes(decision)
  return (
    <div className="rounded-lg border border-qn-border-strong bg-amber-400/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert size={15} className="text-amber-300" />
        <span className="text-ui-md font-medium">{approval.title}</span>
        <Badge tone="warn">{t('等待处理')}</Badge>
      </div>
      <pre className="qn-scroll mb-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-qn-border bg-qn-inset p-2 font-mono text-ui-sm leading-5">
        {approval.detail}
      </pre>
      <div className="flex flex-wrap gap-2">
        {allows('accept') && (
          <button className="qn-button" onClick={() => onDecide('accept')}>
            {t('允许')}
          </button>
        )}
        {allows('acceptForSession') && (
          <button className="qn-button-subtle" onClick={() => onDecide('acceptForSession')}>
            {t('本会话允许')}
          </button>
        )}
        <button className="qn-button-subtle text-qn-danger" onClick={() => onDecide('decline')}>
          {t('拒绝')}
        </button>
      </div>
    </div>
  )
}
