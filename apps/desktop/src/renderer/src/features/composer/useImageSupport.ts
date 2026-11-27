// 当前 Agent + 模型能否接收图片：读 model/list 的 inputModalities（模型选择器的缓存不保留该字段）。

import { useEffect } from 'react'
import { create } from 'zustand'
import { listModels, type CodexRpcLike } from '@qn/codex-client'
import type { AgentKind } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { EMPTY_PREFS, resolveSelection } from '../../lib/models'
import { useCodex } from '../../store/codex'
import { useModels } from '../../store/models'
import { imageSupportFor, modalityTable, type ImageSupport, type ModalityTable } from './images'

type Entry = { table: ModalityTable; stamp: number }

type ModalityState = {
  entries: Record<string, Entry>
  pending: Record<string, boolean>
  load: (key: string, rpc: CodexRpcLike, stamp: number) => Promise<void>
}

const useModalities = create<ModalityState>((set, get) => ({
  entries: {},
  pending: {},
  load: async (key, rpc, stamp) => {
    if (get().pending[key]) return
    set((state) => ({ pending: { ...state.pending, [key]: true } }))
    try {
      const table = modalityTable(await listModels(rpc))
      set((state) => ({ entries: { ...state.entries, [key]: { table, stamp } } }))
    } catch {
      // 取不到模态表时按"未声明"处理（允许发图），记下 stamp 避免反复重试。
      set((state) => ({ entries: { ...state.entries, [key]: { table: { models: {}, defaultModel: null }, stamp } } }))
    } finally {
      set((state) => ({ pending: { ...state.pending, [key]: false } }))
    }
  },
}))

/**
 * 会话打开后取一次 model/list；模型选择器刷新列表（loadedAt 变化）时跟着重取。
 * 只在已打开的会话上调用官方 model/list，不为探测能力单独拉起 Agent。
 */
export function useImageSupport(targetId: string | null, agent: AgentKind, enabled: boolean): ImageSupport {
  const key = targetId ? sessionKey(targetId, agent) : ''
  const session = useCodex((s) => (key ? s.sessions[key] : undefined))
  const list = useModels((s) => (key ? s.lists[key] : undefined))
  const prefs = useModels((s) => s.prefs[agent] ?? EMPTY_PREFS)
  const entry = useModalities((s) => (key ? s.entries[key] : undefined))
  const load = useModalities((s) => s.load)

  const opened = session?.opened === true
  const rpc = session?.rpc
  const stamp = list?.loadedAt ?? 0
  useEffect(() => {
    if (!enabled || agent === 'pi' || !key || !opened || !rpc) return
    if (entry && entry.stamp >= stamp) return
    void load(key, rpc, stamp)
  }, [enabled, agent, key, opened, rpc, entry, stamp, load])

  if (enabled && agent === 'pi') return { allowed: false, reason: 'Pi 不支持图片附件' }
  if (!enabled || !entry) return { allowed: true, reason: null }
  const model = resolveSelection(list?.models ?? [], prefs).model
  return imageSupportFor(entry.table, model?.model ?? null, model?.displayName)
}
