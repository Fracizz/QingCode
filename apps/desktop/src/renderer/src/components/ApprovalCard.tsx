import { ShieldAlert } from 'lucide-react'
import type { ApprovalDecision, ApprovalView } from '@qn/codex-client'
import { Badge } from './ui'

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ApprovalView
  onDecide: (decision: ApprovalDecision) => void
}) {
  return (
    <div className="rounded-lg border border-amber-400/50 bg-amber-400/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert size={15} className="text-amber-300" />
        <span className="text-ui-md font-medium">{approval.title}</span>
        <Badge tone="warn">等待处理</Badge>
      </div>
      <pre className="qn-scroll mb-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-qn-border bg-qn-inset p-2 font-mono text-ui-sm leading-5">
        {approval.detail}
      </pre>
      <div className="flex flex-wrap gap-2">
        <button className="qn-button" onClick={() => onDecide('accept')}>
          允许
        </button>
        <button className="qn-button-subtle" onClick={() => onDecide('acceptForSession')}>
          本会话允许
        </button>
        <button className="qn-button-subtle border-qn-danger/50 text-qn-danger" onClick={() => onDecide('decline')}>
          拒绝
        </button>
      </div>
    </div>
  )
}
