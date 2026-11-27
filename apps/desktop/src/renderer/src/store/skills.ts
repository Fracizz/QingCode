import { create } from 'zustand'
import { listSkills, type CodexRpcLike } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import type { SlashItem } from '../lib/attachments'

type SkillList = { items: SlashItem[]; loading: boolean; error: string | null }

type SkillsState = {
  /** 按 agent + 目标 + cwd 缓存：不同项目的项目级技能不同。 */
  lists: Record<string, SkillList>
  load: (targetId: string, agent: AgentKind, cwd: string | null, rpc: CodexRpcLike, force?: boolean) => Promise<void>
}

export function skillsKey(targetId: string, agent: AgentKind, cwd: string | null): string {
  return `${sessionKey(targetId, agent)}|${cwd ?? ''}`
}

const SCOPE_LABEL: Record<string, string> = { user: '用户', repo: '项目', system: '系统', admin: '管理员' }

export const useSkills = create<SkillsState>((set, get) => ({
  lists: {},

  load: async (targetId, agent, cwd, rpc, force = false) => {
    const key = skillsKey(targetId, agent, cwd)
    const current = get().lists[key]
    if (current?.loading || (current && !current.error && !force)) return
    set((state) => ({ lists: { ...state.lists, [key]: { items: current?.items ?? [], loading: true, error: null } } }))
    try {
      const skills = await listSkills(rpc, cwd)
      const items: SlashItem[] = skills.map((skill) => ({
        id: `skill:${skill.name}`,
        kind: 'skill',
        name: skill.name,
        description: skill.interface?.shortDescription || skill.shortDescription || skill.description || '',
        scope: SCOPE_LABEL[skill.scope] ?? skill.scope,
        path: skill.path,
      }))
      set((state) => ({ lists: { ...state.lists, [key]: { items, loading: false, error: null } } }))
    } catch (err) {
      // 旧版 Codex / 桥接不支持 skills/list 时只是没有技能可选，不算错误打扰用户。
      const error = err instanceof Error ? err.message : '加载技能失败'
      set((state) => ({ lists: { ...state.lists, [key]: { items: [], loading: false, error } } }))
    }
  },
}))
