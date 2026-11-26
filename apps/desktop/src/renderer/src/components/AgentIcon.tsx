import type { AgentKind } from '../../../shared/backendApi'
import { agentLabel } from '../lib/agents'
import { AGENT_MARKS } from './agentMarks'

export function AgentIcon({
  agent,
  size = 12,
  label = false,
  className = '',
}: {
  agent: AgentKind
  size?: number
  label?: boolean
  className?: string
}) {
  const mark = AGENT_MARKS[agent]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`} title={agentLabel(agent)}>
      <svg width={size} height={size} viewBox={mark.viewBox} fill={mark.fill} aria-hidden="true">
        <path d={mark.path} />
      </svg>
      {label && <span className="text-[11px] text-qn-muted">{agentLabel(agent)}</span>}
    </span>
  )
}
