import { listSlashCommands, type CodexRpcLike, type SlashCommandView } from '@qn/codex-client'
import { create } from 'zustand'

type SlashCommandsState = {
  /** 按目标、Agent 与会话缓存：原生命令由运行中的会话进程提供。 */
  lists: Record<string, SlashCommandView[]>
  load: (key: string, threadId: string, rpc: CodexRpcLike) => Promise<void>
}

export function slashCommandsKey(sessionId: string, threadId: string): string {
  return JSON.stringify([sessionId, threadId])
}

// 同一会话的多次读取只采用最后一次的回包。
const latest = new Map<string, symbol>()

export const useSlashCommands = create<SlashCommandsState>((set) => ({
  lists: {},

  load: async (key, threadId, rpc) => {
    const token = Symbol()
    latest.set(key, token)
    try {
      const commands = await listSlashCommands(rpc, threadId)
      if (latest.get(key) === token) set((state) => ({ lists: { ...state.lists, [key]: commands } }))
    } catch {
      // 旧版目标服务或电脑网关没有这个方法时只是没有原生命令可选。
    }
  },
}))

/** 斜杠后的查询词按名称和说明过滤原生命令；名称前缀命中的排前面。 */
export function matchingSlashCommands(commands: readonly SlashCommandView[], query: string): SlashCommandView[] {
  const matches = commands.filter(({ name, description }) =>
    name.toLowerCase().includes(query) || description.toLowerCase().includes(query))
  return query ? matches.sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query))) : matches
}
