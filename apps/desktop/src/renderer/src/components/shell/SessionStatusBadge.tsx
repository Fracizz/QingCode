import { sessionStatusLabels, type SessionStatus } from '@qn/codex-client'

const color: Record<SessionStatus, string> = {
  idle: 'text-qn-dim',
  running: 'bg-qn-brand/10 text-qn-brand',
  pending: 'bg-amber-400/10 text-amber-300',
  input: 'bg-amber-400/10 text-amber-300',
  completed: 'text-qn-muted',
  failed: 'bg-red-400/10 text-qn-danger',
  interrupted: 'text-qn-muted',
  unread: 'bg-qn-brand/10 text-qn-brand',
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] ${color[status]}`}>{sessionStatusLabels[status]}</span>
}
