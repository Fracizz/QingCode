import type { ApprovalView } from '@qn/codex-client'
import { availableApprovalDecisions, type MobileApprovalDecision } from '../state'
import type { AgentKind } from '../types'
import { Badge, Button, Card } from './ui'

const labels: Record<MobileApprovalDecision, string> = {
  accept: '允许',
  acceptForSession: '本会话允许',
  decline: '拒绝',
  cancel: '拒绝并中断',
}

export function ApprovalCard({ approval, agent, submitting, offline, onDecide }: {
  approval: ApprovalView
  agent: AgentKind
  submitting: boolean
  offline: boolean
  onDecide: (decision: MobileApprovalDecision) => void
}) {
  const decisions = availableApprovalDecisions(approval, agent)
  return (
    <Card className="border-qn-warn/60">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">{approval.title}</span>
        <Badge tone="warn">{submitting ? '正在提交' : '待审批'}</Badge>
      </div>
      <pre className="qn-pre qn-scroll mb-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{approval.detail}</pre>
      {decisions.length === 0 ? (
        <p className="text-sm text-qn-muted">请在电脑上处理这个请求。</p>
      ) : (
        <div className="flex flex-wrap gap-2" aria-busy={submitting}>
          {decisions.map((decision) => (
            <Button key={decision} className="grow px-2 text-xs" disabled={submitting || offline}
              variant={decision === 'decline' || decision === 'cancel' ? 'danger' : 'default'}
              onClick={() => onDecide(decision)}>
              {labels[decision]}
            </Button>
          ))}
        </div>
      )}
    </Card>
  )
}
