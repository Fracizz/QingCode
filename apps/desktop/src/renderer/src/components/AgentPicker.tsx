import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { AGENTS, agentLabel, availabilityReason } from '../lib/agents'
import { useCodex } from '../store/codex'
import { AgentIcon } from './AgentIcon'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './primitives'

/**
 * 新会话草稿态下选择 Agent（Codex / Claude）。会话一旦创建 Agent 就固定，只显示不可切换。
 * 不可用的 Agent 置灰并给出原因（未安装/未登录），不隐藏，方便用户知道还能装什么。
 */
export function AgentPicker({ targetId, agent, locked }: { targetId: string | null; agent: AgentKind; locked: boolean }) {
  const statuses = useCodex((s) => (targetId ? s.agents[targetId] : undefined))
  const setDraftAgent = useCodex((s) => s.setDraftAgent)
  const probeAgents = useCodex((s) => s.probeAgents)

  if (locked) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 px-2 text-[13px] text-qn-muted">
        <AgentIcon agent={agent} size={14} />
        {agentLabel(agent)}
      </span>
    )
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover"
          aria-label="选择 Agent"
        >
          <AgentIcon agent={agent} size={14} />
          {agentLabel(agent)}
          <ChevronDown size={14} />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-64">
        <MenuLabel>新会话使用的 Agent</MenuLabel>
        {AGENTS.map((item) => {
          const status = statuses?.[item]
          return (
            <MenuItem
              key={item}
              className="py-1.5"
              disabled={status?.state === 'unavailable'}
              icon={<AgentIcon agent={item} size={15} />}
              hint={item === agent ? <Check size={14} className="text-qn-text" /> : undefined}
              onSelect={() => setDraftAgent(item)}
            >
              <span className="block">{agentLabel(item)}</span>
              <span className="block truncate text-[12px] text-qn-dim">{availabilityReason(item, status)}</span>
            </MenuItem>
          )
        })}
        <MenuSeparator />
        <MenuItem
          icon={<RefreshCw size={14} />}
          disabled={!targetId}
          onSelect={(event) => {
            event.preventDefault()
            if (targetId) void probeAgents(targetId)
          }}
        >
          重新检测
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
