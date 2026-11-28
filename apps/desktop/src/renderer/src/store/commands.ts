import { create } from 'zustand'
import { listSlashCommands, type CodexRpcLike, type SlashCommandView } from '@qn/codex-client'

type CommandsState = {
  /** 按目标、Agent 与会话缓存：原生命令由运行中的会话进程提供。 */
  lists: Record<string, SlashCommandView[]>
  load: (key: string, threadId: string, rpc: CodexRpcLike) => Promise<void>
}

export function commandsKey(sessionId: string, threadId: string): string {
  return JSON.stringify([sessionId, threadId])
}

const latest = new Map<string, symbol>()

export const useCommands = create<CommandsState>((set) => ({
  lists: {},

  load: async (key, threadId, rpc) => {
    const token = Symbol()
    latest.set(key, token)
    try {
      const commands = await listSlashCommands(rpc, threadId)
      if (latest.get(key) === token) set((state) => ({ lists: { ...state.lists, [key]: commands } }))
    } catch {
      // 旧版目标服务没有这个方法时只是没有原生命令可选。
    }
  },
}))
