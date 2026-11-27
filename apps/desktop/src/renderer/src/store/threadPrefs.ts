import { create } from 'zustand'
import { emptyThreadPrefs, parseThreadPrefs, toggleKey, type ThreadPrefs } from '../lib/threadPrefs'

const PREFS_KEY = 'qn-thread-prefs'

type ThreadPrefsState = {
  byTarget: Record<string, ThreadPrefs>
  setPinned: (targetId: string, key: string, pinned: boolean) => void
  setUnread: (targetId: string, key: string, unread: boolean) => void
  setLocalName: (targetId: string, key: string, name: string | null) => void
  setHidden: (targetId: string, key: string, hidden: boolean) => void
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
    setLocalName: (targetId, key, name) =>
      patch(targetId, (prefs) => ({
        ...prefs,
        names: toggleKey(prefs.names, key, name?.trim() ? name.trim() : undefined),
      })),
    setHidden: (targetId, key, hidden) =>
      patch(targetId, (prefs) => ({ ...prefs, hidden: toggleKey(prefs.hidden, key, hidden ? true : undefined) })),
    forget: (targetId, key) =>
      patch(targetId, (prefs) => ({
        pinned: toggleKey(prefs.pinned, key, undefined),
        unread: toggleKey(prefs.unread, key, undefined),
        names: toggleKey(prefs.names, key, undefined),
        hidden: toggleKey(prefs.hidden, key, undefined),
      })),
  }
})
