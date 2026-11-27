import { accessOptions, type AccessMode } from '@qn/codex-client'
import { archivedThreadKey, isAgentKind } from './agents'
import { parseStoredRecord } from './state'
import type { AgentKind, Connection } from './types'

export type AccessAddress = { desktopId: string; targetId: string; agent: AgentKind; threadId: string }
export type AccessPrefs = Record<string, AccessMode>
export const ACCESS_PREFS_STORAGE_KEY = 'threadAccessModes'

export function accessPreferenceKey({ desktopId, targetId, agent, threadId }: AccessAddress, fp: string): string {
  return JSON.stringify([desktopId, fp, targetId, agent, threadId])
}

export function restoreAccessPrefs(raw: string | null, connections: readonly Connection[], archived: Record<string, true>): AccessPrefs {
  const fingerprints = new Map(connections.map(({ id, fp }) => [id, fp]))
  const prefs: AccessPrefs = {}
  for (const [key, value] of Object.entries(parseStoredRecord(raw))) {
    let address: unknown
    try { address = JSON.parse(key) } catch { continue }
    if (!Array.isArray(address) || address.length !== 5) continue
    const [desktopId, fp, targetId, agent, threadId] = address
    if (typeof desktopId !== 'string' || typeof fp !== 'string' || fingerprints.get(desktopId) !== fp ||
        typeof targetId !== 'string' || !isAgentKind(agent) || typeof threadId !== 'string' ||
        archived[archivedThreadKey(desktopId, targetId, { agent, id: threadId })]) continue
    const mode = accessOptions[agent].find((option) => option.mode === value)?.mode
    if (mode) prefs[key] = mode
  }
  return prefs
}
