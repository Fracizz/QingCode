import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import {
  AGENTS,
  agentLabel,
  availabilityReason,
  preferredAgent,
} from '../lib/agents'
import { useCodex } from '../store/codex'
import { AgentIcon } from './AgentIcon'
import { Modal } from './ui'

export function NewThreadDialog({ onClose }: { onClose: () => void }) {
  const targetId = useCodex((s) => s.currentTargetId)
  const cwd = useCodex((s) => s.currentCwd)
  const statuses = useCodex((s) => (s.currentTargetId ? s.agents[s.currentTargetId] : undefined))
  const [choice, setChoice] = useState<AgentKind>(() => preferredAgent(statuses))
  const probeAgents = useCodex((s) => s.probeAgents)

  // 检测完成后若默认 agent 不可用，自动切到唯一可用的那个。
  useEffect(() => {
    if (statuses?.[choice]?.state === 'unavailable') setChoice(preferredAgent(statuses))
  }, [statuses, choice])

  const chosen = statuses?.[choice]
  const disabled = !targetId || chosen?.state === 'unavailable'

  return (
    <Modal
      title="新建会话"
      width="max-w-md"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-[11px] text-qn-muted">
            {cwd ? `工作目录：${cwd}` : '未选择项目，使用目标默认工作目录'}
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" className="qn-button-subtle" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="qn-button"
              disabled={disabled}
              onClick={() => {
                onClose()
                void useCodex.getState().newThread(choice)
              }}
            >
              创建会话
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="text-xs text-qn-muted">选择目标上可用的 Agent</div>
        {AGENTS.map((agent) => {
          const status = statuses?.[agent]
          const unavailable = status?.state === 'unavailable'
          return (
            <button
              key={agent}
              type="button"
              disabled={unavailable}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-xs ${
                choice === agent
                  ? 'border-qn-accent bg-qn-accent/10'
                  : 'border-qn-border hover:bg-white/5'
              } ${unavailable ? 'opacity-50' : ''}`}
              onClick={() => setChoice(agent)}
            >
              <AgentIcon agent={agent} size={16} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{agentLabel(agent)}</span>
                <span className="block truncate text-[11px] text-qn-muted">
                  {availabilityReason(agent, status)}
                </span>
              </span>
              {choice === agent && !unavailable && <span className="text-qn-accent">已选</span>}
            </button>
          )
        })}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-qn-muted">
            未安装或未登录的 Agent 会置灰；安装后刷新检测。
          </span>
          <button
            type="button"
            className="qn-button-subtle flex items-center gap-1 px-2 py-1 text-[11px]"
            disabled={!targetId}
            onClick={() => {
              if (targetId) void probeAgents(targetId)
            }}
          >
            <RefreshCw size={12} /> 刷新检测
          </button>
        </div>
      </div>
    </Modal>
  )
}
