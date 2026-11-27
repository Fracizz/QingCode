import { listSkills, t, type CodexRpcLike } from '@qn/codex-client'
import { create } from 'zustand'
import { sessionKey } from './agents'
import type { AgentKind } from './types'

export type SkillItem = { name: string; description: string; scope: string; path: string }
type SkillList = { items: SkillItem[]; loading: boolean }

type SkillsState = {
  /** 按 agent + 目标 + cwd 缓存：不同项目的项目级技能不同。 */
  lists: Record<string, SkillList>
  load: (key: string, cwd: string | null, rpc: CodexRpcLike, force?: boolean) => Promise<void>
}

export function skillsKey(targetId: string, agent: AgentKind, cwd: string | null): string {
  return JSON.stringify([sessionKey(targetId, agent), cwd])
}

const SCOPE_LABEL: Record<string, string> = { user: t('用户'), repo: t('项目'), system: t('系统'), admin: t('管理员') }

/** 与电脑版同一份 skills/list：Codex 原生支持，Claude / pi 由目标机上的桥扫描各自的技能目录。 */
export const useSkills = create<SkillsState>((set, get) => ({
  lists: {},

  load: async (key, cwd, rpc, force = false) => {
    const current = get().lists[key]
    if (current?.loading || (current && !force)) return
    const pending: SkillList = { items: current?.items ?? [], loading: true }
    set((state) => ({ lists: { ...state.lists, [key]: pending } }))
    const finish = (items: SkillItem[]) => set((state) => state.lists[key] === pending
      ? { lists: { ...state.lists, [key]: { items, loading: false } } } : state)
    try {
      const skills = await listSkills(rpc, cwd)
      finish(skills.map((skill) => ({
        name: skill.name,
        description: skill.interface?.shortDescription || skill.shortDescription || skill.description || '',
        scope: SCOPE_LABEL[skill.scope] ?? skill.scope,
        path: skill.path,
      })))
    } catch {
      // 旧版 Agent / 桥不支持 skills/list 时只是没有技能可选，不打扰用户。
      finish([])
    }
  },
}))

/** 斜杠后的查询词按名称和说明过滤技能；名称前缀命中的排前面。 */
export function matchingSkills(skills: readonly SkillItem[], query: string): SkillItem[] {
  const q = query.toLowerCase()
  const matches = skills.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q))
  return q ? matches.sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q))) : matches
}
