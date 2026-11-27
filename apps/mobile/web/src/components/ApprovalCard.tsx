import { t, translateMessage } from '@qn/codex-client'
import type { ApprovalView } from '@qn/codex-client'
import { ShieldAlert } from 'lucide-react'
import { availableApprovalDecisions, type MobileApprovalDecision } from '../state'
import type { AgentKind } from '../types'
import { Badge, Button, Card } from './ui'

const ORDER: MobileApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel']

const labels: Record<MobileApprovalDecision, string> = {
  accept: t('允许'),
  acceptForSession: t('本会话允许'),
  decline: t('拒绝'),
  cancel: t('拒绝并中断'),
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
    <Card className="qn-approval">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert size={16} className="shrink-0 text-qn-warn" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium break-words">{translateMessage(approval.title)}</span>
        <Badge tone="warn">{submitting ? t('正在提交') : t('待审批')}</Badge>
      </div>
      <pre className="qn-pre qn-scroll mb-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{approval.detail}</pre>
      {decisions.length === 0 ? (
        <p className="text-sm text-qn-muted">{t('请在电脑上处理这个请求。')}</p>
      ) : (
        // 「允许」是主操作；拒绝类放后面，避免误触。
        <div className="grid grid-cols-2 gap-2" aria-busy={submitting}>
          {[...decisions].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map((decision) => (
            <Button key={decision} className={`px-2 text-[13px]${decisions.length % 2 === 1 && decision === 'accept' ? ' col-span-2' : ''}`}
              disabled={submitting || offline}
              variant={decision === 'accept' ? 'primary' : decision === 'decline' || decision === 'cancel' ? 'danger' : 'default'}
              onClick={() => onDecide(decision)}>
              {labels[decision]}
            </Button>
          ))}
        </div>
      )}
    </Card>
  )
}
