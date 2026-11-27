import { create } from 'zustand'
import { emptyThreadPrefs, parseThreadPrefs, toggleKey, type ThreadPrefs } from '../lib/threadPrefs'
import { threadKey } from '../lib/threads'
import type { AgentKind } from '../../../shared/backendApi'

const PREFS_KEY = 'qn-thread-prefs'

type ThreadPrefsState = {
  byTarget: Record<string, ThreadPrefs>
  setPinned: (targetId: string, key: string, pinned: boolean) => void
  setUnread: (targetId: string, key: string, unread: boolean) => void
  /** 用目标机的未读列表整体替换该目标的本地未读记录。 */
  replaceUnread: (targetId: string, keys: string[]) => void
  setLocalName: (targetId: string, key: string, name: string | null) => void
  setArchived: (targetId: string, agent: AgentKind, threadId: string, archived: boolean) => void
  /** 旧版本地归档已补写到目标机后清除。 */
  clearHidden: (targetId: string, key: string) => void
  setRevisionTurn: (targetId: string, key: string, turnId: string) => void
  /** 会话被永久删除后清掉它的所有本地偏好。 */
  forget: (targetId: string, key: string) => void
}

const read = (): Record<string, ThreadPrefs> => {
  try {
    return parseThreadPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY))
  } catch {
    return {}
  }
}

const save = (value: Record<string, ThreadPrefs>): void => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(value))
  } catch {
    // 存储不可用时只影响下次启动。
  }
}

export const useThreadPrefs = create<ThreadPrefsState>((set, get) => {
  const patch = (targetId: string, update: (prefs: ThreadPrefs) => ThreadPrefs): void => {
    const current = get().byTarget
    const byTarget = { ...current, [targetId]: update(current[targetId] ?? emptyThreadPrefs()) }
    set({ byTarget })
    save(byTarget)
  }

  return {
    byTarget: read(),
    setPinned: (targetId, key, pinned) =>
      patch(targetId, (prefs) => ({ ...prefs, pinned: toggleKey(prefs.pinned, key, pinned ? Date.now() : undefined) })),
    setUnread: (targetId, key, unread) => {
      // 打开会话时会频繁调用清除，没有变化就不写存储。
      if (!unread && !get().byTarget[targetId]?.unread[key]) return
      patch(targetId, (prefs) => ({ ...prefs, unread: toggleKey(prefs.unread, key, unread ? true : undefined) }))
    },
    replaceUnread: (targetId, keys) => {
      const current = get().byTarget[targetId]?.unread ?? {}
      const same = keys.length === Object.keys(current).length && keys.every((key) => current[key])
      if (same) return
      patch(targetId, (prefs) => ({ ...prefs, unread: Object.fromEntries(keys.map((key) => [key, true as const])) }))
    },
    setLocalName: (targetId, key, name) =>
      patch(targetId, (prefs) => ({
        ...prefs,
        names: toggleKey(prefs.names, key, name?.trim() ? name.trim() : undefined),
      })),
    setArchived: (targetId, agent, threadId, archived) => {
      const key = threadKey(agent, threadId)
      patch(targetId, (prefs) => ({
        ...prefs,
        // 归档状态以目标机为准，本地只在恢复时清掉旧版遗留的隐藏标记。
        hidden: archived ? prefs.hidden : toggleKey(prefs.hidden, key, undefined),
        pinned: archived ? toggleKey(prefs.pinned, key, undefined) : prefs.pinned,
        restoredAt: toggleKey(prefs.restoredAt, key, archived ? undefined : Date.now()),
      }))
    },
    clearHidden: (targetId, key) => {
      if (!get().byTarget[targetId]?.hidden[key]) return
      patch(targetId, (prefs) => ({ ...prefs, hidden: toggleKey(prefs.hidden, key, undefined) }))
    },
    setRevisionTurn: (targetId, key, turnId) =>
      patch(targetId, (prefs) => ({ ...prefs, revisionTurns: toggleKey(prefs.revisionTurns, key, turnId) })),
    forget: (targetId, key) =>
      patch(targetId, (prefs) => ({
        pinned: toggleKey(prefs.pinned, key, undefined),
        unread: toggleKey(prefs.unread, key, undefined),
        names: toggleKey(prefs.names, key, undefined),
        hidden: toggleKey(prefs.hidden, key, undefined),
        restoredAt: toggleKey(prefs.restoredAt, key, undefined),
        revisionTurns: toggleKey(prefs.revisionTurns, key, undefined),
      })),
  }
})
