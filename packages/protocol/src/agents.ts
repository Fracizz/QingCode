import type { AgentKind } from './messages'

/**
 * 当前版本的桥对各 Agent 实现了哪些能力。界面按能力决定入口是否可用，不按 agent id 判断。
 * 这里写的是 QingCode 的实现情况，不代表 Agent 本身的上限；说明见 docs/agent-capabilities.md。
 * Claude、pi 的方法级能力由 server/src/agentCapabilities.test.ts 核对，声明与实现须一起改。
 */
export type AgentCapabilities = {
  approvals: boolean
  rateLimits: boolean
  accessModes: boolean
  agentConfigDir: boolean
  /** 临时会话可禁用全部工具。 */
  ephemeralNoTools: boolean
  rename: boolean
  delete: boolean
  fork: boolean
  archive: boolean
  /** 原会话内回退到某一轮之前（编辑重发）。 */
  revert: boolean
  compact: boolean
  steer: boolean
  skills: boolean
}

export const AGENT_CAPABILITIES: Readonly<Record<AgentKind, Readonly<AgentCapabilities>>> = {
  codex: {
    approvals: true, rateLimits: true, accessModes: true, agentConfigDir: true, ephemeralNoTools: false,
    rename: true, delete: true, fork: true, archive: true, revert: true, compact: true, steer: true, skills: true,
  },
  claude: {
    approvals: true, rateLimits: true, accessModes: true, agentConfigDir: true, ephemeralNoTools: false,
    rename: true, delete: true, fork: true, archive: true, revert: false, compact: true, steer: true, skills: true,
  },
  pi: {
    approvals: false, rateLimits: false, accessModes: false, agentConfigDir: false, ephemeralNoTools: true,
    rename: true, delete: false, fork: true, archive: true, revert: false, compact: true, steer: true, skills: true,
  },
}

/** 在终端里继续同一会话的官方命令。 */
export function agentResumeCommand(agent: AgentKind, threadId: string): string {
  switch (agent) {
    case 'codex': return `codex resume ${threadId}`
    case 'claude': return `claude --resume ${threadId}`
    case 'pi': return `pi --session ${threadId}`
  }
}
