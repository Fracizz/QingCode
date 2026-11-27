import type { ThreadView } from './conversation'

export type ThreadOutcome = 'completed' | 'failed' | 'interrupted'
export type ThreadActivity = ThreadOutcome | 'idle' | 'running' | 'pending' | 'input'
export type SessionStatus = ThreadActivity | 'unread'

export const sessionStatusLabels: Record<SessionStatus, string> = {
  idle: '空闲',
  running: '运行中',
  pending: '待审批',
  input: '待输入',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  unread: '有新结果',
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

export function sessionStatus(
  view?: Pick<ThreadView, 'activity' | 'status'> & { pendingApprovals: readonly unknown[] },
  listed?: ThreadActivity,
  unread = false,
): SessionStatus {
  if (view?.pendingApprovals.length) return 'pending'
  const activity = view?.activity ?? (view ? runtimeActivity[view.status] : listed) ?? 'idle'
  if (unread && (activity === 'idle' || activity === 'completed')) return 'unread'
  return activity
}
