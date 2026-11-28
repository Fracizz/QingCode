import {
  AGENT_CAPABILITIES, accessOptions, type AccessSelection, type ItemView, type SessionAccessSelection,
} from '@qn/codex-client'
import { archivedThreadKey, isAgentKind } from './agents'
import { parseStoredRecord } from './state'
import type { AgentKind, Connection } from './types'

export type AccessAddress = { desktopId: string; targetId: string; agent: AgentKind; threadId: string }
/** 计划模式连同批准后要切回的选择一起保存；seenExit 是选择时已经见过的最近一次计划批准条目。 */
export type PlanPreference = { mode: 'plan'; back: AccessSelection; seenExit?: string }
export type AccessPref = AccessSelection | PlanPreference
export type AccessPrefs = Record<string, AccessPref>
export const ACCESS_PREFS_STORAGE_KEY = 'threadAccessModes'

export function accessPreferenceKey({ desktopId, targetId, agent, threadId }: AccessAddress, fp: string): string {
  return JSON.stringify([desktopId, fp, targetId, agent, threadId])
}

export function accessSelectionOf(pref: AccessPref | undefined): SessionAccessSelection | undefined {
  return typeof pref === 'object' ? pref.mode : pref
}

/** 记下会话的选择；进入计划模式时同时记下原来的选择，重复选计划模式不覆盖它。 */
export function selectAccess(prefs: AccessPrefs, key: string, mode: SessionAccessSelection, seenExit?: string): AccessPrefs {
  if (mode !== 'plan') return { ...prefs, [key]: mode }
  const previous = prefs[key]
  if (typeof previous === 'object') return prefs
  return { ...prefs, [key]: { mode, back: previous ?? 'inherit', ...(seenExit ? { seenExit } : {}) } }
}

/** 计划获批后切回原来的选择；当前不在计划模式时原样返回。 */
export function leavePlanPreference(prefs: AccessPrefs, key: string): AccessPrefs {
  const pref = prefs[key]
  return typeof pref === 'object' ? { ...prefs, [key]: pref.back } : prefs
}

/** 会话里最近一次已获批准的退出计划条目。 */
export function latestPlanExit(items: readonly ItemView[] | undefined): string | undefined {
  return items?.findLast((item) => item.kind === 'other' && item.plan !== undefined && item.status === 'completed')?.id
}

function restoreSelection(agent: AgentKind, value: unknown): AccessSelection | undefined {
  return agent !== 'pi' && value === 'inherit' ? value : accessOptions[agent].find((option) => option.mode === value)?.mode
}

function restorePreference(agent: AgentKind, value: unknown): AccessPref | undefined {
  if (typeof value !== 'object' || value === null) return restoreSelection(agent, value)
  // 计划模式只接受带返回档位的记录。
  const { mode, back, seenExit } = value as Record<string, unknown>
  if (mode !== 'plan' || !AGENT_CAPABILITIES[agent].planMode) return undefined
  return { mode, back: restoreSelection(agent, back) ?? 'inherit', ...(typeof seenExit === 'string' ? { seenExit } : {}) }
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
    const pref = restorePreference(agent, value)
    if (pref) prefs[key] = pref
  }
  return prefs
}
