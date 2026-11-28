import { t } from '../../protocol/src/i18n'
import type { ThreadView } from './conversation'

export type ThreadOutcome = 'completed' | 'failed' | 'interrupted'
export type ThreadActivity = ThreadOutcome | 'idle' | 'running' | 'pending' | 'input'
export type SessionStatus = ThreadActivity | 'unread'

export const sessionStatusLabels: Record<SessionStatus, string> = {
  idle: t('空闲'),
  running: t('运行中'),
  pending: t('待审批'),
  input: t('待回答'),
  completed: t('已完成'),
  failed: t('失败'),
  interrupted: t('已中断'),
  unread: t('有新结果'),
}

const runtimeActivity: Record<ThreadView['status'], ThreadActivity> = {
  idle: 'idle', running: 'running', error: 'failed',
}

export function isThreadOutcome(value: unknown): value is ThreadOutcome {
  return value === 'completed' || value === 'failed' || value === 'interrupted'
}

export function isActiveThread(value: SessionStatus): boolean {
  return value === 'running' || value === 'pending' || value === 'input'
}

export function threadActivityFromStatus(value: unknown): ThreadActivity | undefined {
  const raw = typeof value === 'object' && value !== null ? value as { type?: unknown; activeFlags?: unknown } : null
  switch (raw?.type ?? value) {
    case 'active': {
      const flags = Array.isArray(raw?.activeFlags) ? raw.activeFlags : []
      if (flags.includes('waitingOnApproval')) return 'pending'
      return flags.includes('waitingOnUserInput') ? 'input' : 'running'
    }
    case 'systemError': return 'failed'
    case 'idle':
    case 'notLoaded': return 'idle'
    default: return undefined
  }
}

function isQuestion(approval: unknown): boolean {
  const questions = typeof approval === 'object' && approval !== null ? (approval as { questions?: unknown }).questions : undefined
  return Array.isArray(questions) && questions.length > 0
}

export function sessionStatus(
  view?: Pick<ThreadView, 'activity' | 'status'> & { pendingApprovals: readonly unknown[] },
  listed?: ThreadActivity,
  unread = false,
): SessionStatus {
  // 只剩 Agent 提问时是在等用户回答，不是审批，与卡片上的“等待回答”保持一致。
  if (view?.pendingApprovals.length) return view.pendingApprovals.every(isQuestion) ? 'input' : 'pending'
  const activity = view?.activity ?? (view ? runtimeActivity[view.status] : listed) ?? 'idle'
  if (unread && (activity === 'idle' || activity === 'completed')) return 'unread'
  return activity
}
