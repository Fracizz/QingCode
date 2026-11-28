import { t, translateMessage } from '@qn/codex-client'
import type { ApprovalView } from '@qn/codex-client'
import { ListTodo, ShieldAlert } from 'lucide-react'
import { availableApprovalDecisions, type MobileApprovalDecision } from '../state'
import type { AgentKind } from '../types'
import { Markdown } from './MessageItem'
import { Badge, Button, Card } from './ui'

const ORDER: MobileApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel']

const labels: Record<MobileApprovalDecision, string> = {
  accept: t('允许'),
  acceptForSession: t('本会话允许'),
  decline: t('拒绝'),
  cancel: t('拒绝并中断'),
}

// 计划审批只有两个选择，没有“本会话允许”和中断。
const PLAN_DECISIONS: MobileApprovalDecision[] = ['accept', 'decline']

export function ApprovalCard({ approval, agent, plan, submitting, offline, onDecide }: {
  approval: ApprovalView
  agent: AgentKind
  /** 有值表示这是退出计划模式的审批，内容为完整计划（取不到时为空串）。 */
  plan?: string
  submitting: boolean
  offline: boolean
  onDecide: (decision: MobileApprovalDecision) => void
}) {
  const decisions = availableApprovalDecisions(approval, agent)
  if (plan !== undefined) {
    const choices = PLAN_DECISIONS.filter((decision) => decisions.includes(decision))
    return (
      <Card className="qn-approval">
        <div className="mb-2 flex items-center gap-2">
          <ListTodo size={16} className="shrink-0 text-qn-accent" aria-hidden />
          <span className="min-w-0 flex-1 text-sm font-medium break-words">{t('计划待批准')}</span>
          <Badge tone="warn">{submitting ? t('正在提交') : t('待审批')}</Badge>
        </div>
        <div className="qn-scroll mb-2 max-h-[50dvh] overflow-auto rounded-lg border border-qn-border bg-qn-field px-3 py-2">
          {plan.trim()
            ? <div className="qn-markdown min-w-0 wrap-anywhere"><Markdown text={plan} streaming={false} /></div>
            : <pre className="qn-pre whitespace-pre-wrap text-xs">{approval.detail}</pre>}
        </div>
        {choices.length === 0 ? (
          <p className="text-sm text-qn-muted">{t('请在电脑上处理这个请求。')}</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-qn-muted">{t('批准后退出计划模式并开始执行；继续规划则保持计划模式。')}</p>
            <div className="grid grid-cols-2 gap-2" aria-busy={submitting}>
              {choices.map((decision) => (
                <Button key={decision} className="px-2 text-compact" disabled={submitting || offline}
                  variant={decision === 'accept' ? 'primary' : 'default'} onClick={() => onDecide(decision)}>
                  {decision === 'accept' ? t('批准计划') : t('继续规划')}
                </Button>
              ))}
            </div>
          </>
        )}
      </Card>
    )
  }
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
            <Button key={decision} className={`px-2 text-compact${decisions.length % 2 === 1 && decision === 'accept' ? ' col-span-2' : ''}`}
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
