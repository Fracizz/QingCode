import {
  resolveAccessMode, sessionAccessOptions,
  type AccessSelection, type GlobalAccessMode, type SessionAccessMode, type SessionAccessSelection,
} from '@qn/codex-client'
import type { AgentKind } from '../../../../shared/backendApi'

export { sessionAccessOptions, turnAccessOverride, type SessionAccessSelection } from '@qn/codex-client'

export type AccessAddress = { targetId: string; agent: AgentKind; threadId: string | null }

export type AccessMemory = {
  draftRevision: number
  draft: { key: string; mode: SessionAccessMode; planReturn?: AccessSelection } | null
  modes: Record<string, SessionAccessMode>
  /** 选计划模式前的选择，批准计划或退出时切回去。 */
  planReturns?: Record<string, AccessSelection>
}

export const emptyAccessMemory: AccessMemory = { draftRevision: 0, draft: null, modes: {} }

export const accessKey = ({ targetId, agent, threadId }: AccessAddress) =>
  JSON.stringify([targetId, agent, threadId])

export function getAccessSelection(memory: AccessMemory, address: AccessAddress): SessionAccessSelection {
  const key = accessKey(address)
  if (address.threadId === null) return memory.draft?.key === key ? memory.draft.mode : 'inherit'
  return memory.modes[key] ?? 'inherit'
}

export function getAccessMode(memory: AccessMemory, address: AccessAddress, globalMode?: GlobalAccessMode): SessionAccessMode {
  return resolveAccessMode(address.agent, globalMode, getAccessSelection(memory, address))
}

/** 退出计划模式后应恢复的选择。 */
export function planReturnSelection(memory: AccessMemory, address: AccessAddress): AccessSelection {
  const key = accessKey(address)
  const saved = address.threadId === null
    ? (memory.draft?.key === key ? memory.draft.planReturn : undefined)
    : memory.planReturns?.[key]
  return saved ?? 'inherit'
}

export function rememberAccessMode(
  memory: AccessMemory,
  address: AccessAddress,
  mode: SessionAccessSelection,
  /** 草稿转成会话时带上草稿记录的返回档位。 */
  planReturn?: AccessSelection,
): AccessMemory {
  if (mode !== 'inherit' && !sessionAccessOptions(address.agent).some((option) => option.mode === mode)) return memory
  const key = accessKey(address)
  const previous = getAccessSelection(memory, address)
  const back = mode !== 'plan' ? undefined
    : planReturn ?? (previous === 'plan' ? planReturnSelection(memory, address) : previous)
  if (address.threadId === null) {
    return { ...memory, draft: mode === 'inherit' ? null : { key, mode, ...(back ? { planReturn: back } : {}) } }
  }
  const modes = { ...memory.modes }
  if (mode === 'inherit') delete modes[key]
  else modes[key] = mode
  if (!back && !memory.planReturns?.[key]) return { ...memory, modes }
  const planReturns = { ...memory.planReturns }
  if (back) planReturns[key] = back
  else delete planReturns[key]
  return { ...memory, modes, planReturns }
}

/** 计划获批后切出计划模式；当前不在计划模式时原样返回。 */
export function leavePlanMode(memory: AccessMemory, address: AccessAddress): AccessMemory {
  if (getAccessSelection(memory, address) !== 'plan') return memory
  return rememberAccessMode(memory, address, planReturnSelection(memory, address))
}

const PERMISSIVENESS: Record<SessionAccessMode, number> = { plan: 0, default: 1, auto: 2, fullAccess: 3 }

/**
 * 分支出的新会话按总控运行，不带走单独提升的权限；
 * 原会话比总控更严格时保留原选择，避免换了会话反而放宽。
 */
export function branchAccessSelection(
  memory: AccessMemory,
  source: AccessAddress,
  globalMode?: GlobalAccessMode,
): SessionAccessSelection {
  const inherited = resolveAccessMode(source.agent, globalMode)
  return PERMISSIVENESS[getAccessMode(memory, source, globalMode)] < PERMISSIVENESS[inherited]
    ? getAccessSelection(memory, source) : 'inherit'
}

export function resetDraftAccess(memory: AccessMemory): AccessMemory {
  return { ...memory, draft: null, draftRevision: memory.draftRevision + 1 }
}

export function targetAgentKeyPrefix(targetId: string, agent: AgentKind): string {
  return `${JSON.stringify([targetId, agent]).slice(0, -1)},`
}

export function resetTargetAccess(memory: AccessMemory, targetId: string, agent: AgentKind): AccessMemory {
  const prefix = targetAgentKeyPrefix(targetId, agent)
  const keep = <T,>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith(prefix)))
  return { ...memory, modes: keep(memory.modes), ...(memory.planReturns ? { planReturns: keep(memory.planReturns) } : {}) }
}
