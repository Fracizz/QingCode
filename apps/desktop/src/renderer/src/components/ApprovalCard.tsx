import { ShieldAlert } from 'lucide-react'
import type { ApprovalDecision, ApprovalView } from '@qn/codex-client'
import { t } from '@qn/codex-client'
import { Badge } from './ui'
import { UserInputCard } from './UserInputCard'

export function ApprovalCard({
  approval,
  onDecide,
  onAnswer,
}: {
  approval: ApprovalView
  onDecide: (decision: ApprovalDecision) => void
  /** Agent 提问（item/tool/requestUserInput）的回答；提供时按问答卡片渲染。 */
  onAnswer?: (answers: Record<string, string[]>) => void
}) {
  if (approval.questions && approval.questions.length > 0 && onAnswer) {
    return <UserInputCard approval={approval} onSubmit={onAnswer} />
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
