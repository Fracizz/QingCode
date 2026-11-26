import type { ApprovalDecision, ApprovalView } from '@qn/codex-client'
import { Badge, Button, Card } from './ui'

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ApprovalView
  onDecide: (decision: ApprovalDecision) => void
}) {
  return (
    <Card className="border-qn-warn/60">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">{approval.title}</span>
        <Badge tone="warn">待审批</Badge>
      </div>
      <pre className="qn-pre qn-scroll mb-3 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
        {approval.detail}
      </pre>
      <div className="flex gap-2">
        <Button className="flex-1" variant="primary" onClick={() => onDecide('accept')}>
          允许
        </Button>
        <Button className="flex-1" onClick={() => onDecide('acceptForSession')}>
          本会话允许
        </Button>
        <Button className="flex-1" variant="danger" onClick={() => onDecide('decline')}>
          拒绝
        </Button>
      </div>
    </Card>
  )
}
