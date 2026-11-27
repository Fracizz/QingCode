import { accessOptions, resolveAccessMode, type AccessMode, type AccessSelection, type GlobalAccessMode } from '@qn/codex-client'
import type { AgentKind } from '../../../../shared/backendApi'

export { accessOptions, turnAccessOverride, type AccessSelection } from '@qn/codex-client'

export type AccessAddress = { targetId: string; agent: AgentKind; threadId: string | null }

export type AccessMemory = {
  draftRevision: number
  draft: { key: string; mode: AccessMode } | null
  modes: Record<string, AccessMode>
}

export const emptyAccessMemory: AccessMemory = { draftRevision: 0, draft: null, modes: {} }

export const accessKey = ({ targetId, agent, threadId }: AccessAddress) =>
  JSON.stringify([targetId, agent, threadId])

export function getAccessSelection(memory: AccessMemory, address: AccessAddress): AccessSelection {
  const key = accessKey(address)
  if (address.threadId === null) return memory.draft?.key === key ? memory.draft.mode : 'inherit'
  return memory.modes[key] ?? 'inherit'
}

export function getAccessMode(memory: AccessMemory, address: AccessAddress, globalMode?: GlobalAccessMode): AccessMode {
  return resolveAccessMode(address.agent, globalMode, getAccessSelection(memory, address))
}

export function rememberAccessMode(memory: AccessMemory, address: AccessAddress, mode: AccessSelection): AccessMemory {
  if (mode !== 'inherit' && !accessOptions[address.agent].some((option) => option.mode === mode)) return memory
  const key = accessKey(address)
  if (address.threadId === null) return { ...memory, draft: mode === 'inherit' ? null : { key, mode } }
  const modes = { ...memory.modes }
  if (mode === 'inherit') delete modes[key]
  else modes[key] = mode
  return { ...memory, modes }
}

export function resetDraftAccess(memory: AccessMemory): AccessMemory {
  return { ...memory, draft: null, draftRevision: memory.draftRevision + 1 }
}

export function targetAgentKeyPrefix(targetId: string, agent: AgentKind): string {
  return `${JSON.stringify([targetId, agent]).slice(0, -1)},`
}

export function resetTargetAccess(memory: AccessMemory, targetId: string, agent: AgentKind): AccessMemory {
  const prefix = targetAgentKeyPrefix(targetId, agent)
  return { ...memory, modes: Object.fromEntries(Object.entries(memory.modes).filter(([key]) => !key.startsWith(prefix))) }
}
