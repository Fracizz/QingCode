import { Bot, Sparkles } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { agentLabel } from '../lib/agents'

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
  const Icon = agent === 'claude' ? Sparkles : Bot
  const color = agent === 'claude' ? 'text-amber-300' : 'text-qn-accent'
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${color} ${className}`} title={agentLabel(agent)}>
      <Icon size={size} />
      {label && <span className="text-[10px]">{agentLabel(agent)}</span>}
    </span>
  )
}
