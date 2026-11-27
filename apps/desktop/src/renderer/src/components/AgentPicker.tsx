import { Check, ChevronDown, Pin, PinOff, RotateCw } from 'lucide-react'
import { t, translateMessage } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { AGENTS, agentLabel, availabilityReason } from '../lib/agents'
import { agentPrefs, useSettings } from '../features/settings'
import { useAgentPrefs } from '../store/agentPrefs'
import { useCodex } from '../store/codex'
import { useTargets } from '../store/targets'
import { AgentIcon } from './AgentIcon'
import { targetDisplayName } from './targetName'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './primitives'
import { Badge } from './ui'

/**
 * 新会话草稿态下选择 Agent（Codex / Claude）。会话一旦创建 Agent 就固定，只显示不可切换。
 * 不可用的 Agent 置灰并给出原因（未安装/未登录），不隐藏，方便用户知道还能装什么。
 */
export function AgentPicker({ targetId, agent, locked }: { targetId: string | null; agent: AgentKind; locked: boolean }) {
  const statuses = useCodex((s) => (targetId ? s.agents[targetId] : undefined))
  const setDraftAgent = useCodex((s) => s.setDraftAgent)
  const probeAgents = useCodex((s) => s.probeAgents)
  const defaultAgent = useAgentPrefs((s) => (targetId ? s.byTarget[targetId] : undefined))
  const setDefault = useAgentPrefs((s) => s.setDefault)
  const target = useTargets((s) => s.targets.find((item) => item.id === targetId))
  const targetName = target ? targetDisplayName(target) : t('此连接')
  const isDefault = defaultAgent === agent
  // 设置 → Agent 里对该目标关闭的 Agent 不出现在新建会话的选择里（当前所选除外，避免选中项消失）。
  const settings = useSettings((s) => s.settings)
  const visible = AGENTS.filter((item) => item === agent || !targetId || agentPrefs(settings, targetId, item).enabled)

  if (locked) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 px-2 text-ui text-qn-muted">
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
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-ui text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover data-[state=open]:bg-qn-hover"
          aria-label={t('选择 Agent')}
        >
          <AgentIcon agent={agent} size={14} />
          {agentLabel(agent)}
          <ChevronDown size={14} />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuLabel>{t('新会话使用的 Agent')}</MenuLabel>
        {visible.map((item) => {
          const status = statuses?.[item]
          return (
            <MenuItem
              key={item}
              className="py-1.5"
              disabled={status?.state === 'unavailable'}
              icon={<AgentIcon agent={item} size={16} />}
              hint={item === agent ? <Check size={14} className="text-qn-text" /> : undefined}
              onSelect={() => setDraftAgent(item)}
            >
              <span className="flex items-center gap-1.5">
                {agentLabel(item)}
                {item === defaultAgent && <Badge>{t('默认')}</Badge>}
              </span>
              <span className="block truncate text-ui-sm text-qn-dim">{translateMessage(availabilityReason(item, status))}</span>
            </MenuItem>
          )
        })}
        <MenuSeparator />
        <MenuItem
          icon={isDefault ? <PinOff size={14} /> : <Pin size={14} />}
          disabled={!targetId}
          onSelect={(event) => {
            event.preventDefault()
            if (targetId) setDefault(targetId, isDefault ? null : agent)
          }}
        >
          {isDefault
            ? t('取消「{target}」的默认 Agent', { target: targetName })
            : t('将 {agent} 设为「{target}」默认', { agent: agentLabel(agent), target: targetName })}
        </MenuItem>
        <MenuItem
          icon={<RotateCw size={14} />}
          disabled={!targetId}
          onSelect={(event) => {
            event.preventDefault()
            if (targetId) void probeAgents(targetId, true)
          }}
        >
          {t('重新检测')}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
