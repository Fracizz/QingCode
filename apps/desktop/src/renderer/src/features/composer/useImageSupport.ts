// 当前 Agent + 模型能否接收图片：复用模型选择器缓存里同一次 model/list 的 inputModalities，不再单独请求。

import { useEffect } from 'react'
import type { AgentKind } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { resolveSelection } from '../../lib/models'
import { useCodex } from '../../store/codex'
import { prefsFor, useModels } from '../../store/models'
import { imageSupportFor, type ImageSupport } from './images'

/**
 * 会话打开后确保模型列表已加载（与模型选择器共用缓存和去重，不强制刷新）。
 * 只在已打开的会话上调用官方 model/list，不为探测能力单独拉起 Agent。
 */
export function useImageSupport(targetId: string | null, agent: AgentKind, enabled: boolean, threadId: string | null = null): ImageSupport {
  const key = targetId ? sessionKey(targetId, agent) : ''
  const rpc = useCodex((s) => {
    const session = key ? s.sessions[key] : undefined
    return session?.opened ? session.rpc : undefined
  })
  const list = useModels((s) => (key ? s.lists[key] : undefined))
  const prefs = useModels((s) => prefsFor(s, targetId, agent, threadId))
  const load = useModels((s) => s.load)

  useEffect(() => {
    if (enabled && targetId && rpc) void load(targetId, agent, rpc)
  }, [enabled, targetId, agent, rpc, load])

  const table = list?.modalities
  if (!enabled || !table) return { allowed: true, reason: null }
  const model = resolveSelection(list.models, prefs).model
  return imageSupportFor(table, model?.model ?? null, model?.displayName)
}
