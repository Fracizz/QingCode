import { Cpu } from 'lucide-react'
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
  // pi 用中性图形，不借用任何厂商标识。
  const mark = agent === 'pi' ? null : AGENT_MARKS[agent]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`} title={agentLabel(agent)}>
      {mark ? (
        <svg width={size} height={size} viewBox={mark.viewBox} style={{ fill: mark.fill }} aria-hidden="true">
          <path d={mark.path} />
        </svg>
      ) : (
        <Cpu size={size} className="text-qn-muted" aria-hidden="true" />
      )}
      {label && <span className="text-ui-xs text-qn-muted">{agentLabel(agent)}</span>}
    </span>
  )
}
