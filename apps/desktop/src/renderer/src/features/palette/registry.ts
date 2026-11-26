import { useSyncExternalStore } from 'react'
import type { PaletteCommand } from './types'

// 命令注册表：各功能模块按需登记命令，面板只读快照。
// 每次 register 记为一条登记，重复 id 时后登记者生效；注销后登记被移除，
// 先登记的同 id 命令随之恢复，组件卸载/重挂不会把别人的命令弄丢。

export type CommandRegistry = {
  register: (commands: readonly PaletteCommand[]) => () => void
  /** 去重后的命令快照；内容不变时返回同一数组引用（供 useSyncExternalStore） */
  getCommands: () => readonly PaletteCommand[]
  get: (id: string) => PaletteCommand | undefined
  subscribe: (listener: () => void) => () => void
}

export type RegistryOptions = {
  /** 重复 id 时的告警；默认只在开发模式 console.warn */
  warn?: (message: string) => void
}

const isDev = (): boolean => {
  try {
    return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  } catch {
    return false
  }
}

const defaultWarn = (message: string): void => {
  if (isDev()) console.warn(message)
}

export function createCommandRegistry(options: RegistryOptions = {}): CommandRegistry {
  const warn = options.warn ?? defaultWarn
  let entries: Array<{ token: symbol; commands: readonly PaletteCommand[] }> = []
  let snapshot: readonly PaletteCommand[] = []
  let byId = new Map<string, PaletteCommand>()
  const listeners = new Set<() => void>()

  const rebuild = (): void => {
    const next = new Map<string, PaletteCommand>()
    for (const entry of entries) {
      // Map.set 覆盖值但保留首次插入位置，列表顺序稳定
      for (const command of entry.commands) next.set(command.id, command)
    }
    byId = next
    snapshot = [...next.values()]
    for (const listener of [...listeners]) listener()
  }

  return {
    register(commands) {
      const ids = new Set<string>()
      for (const command of commands) {
        if (ids.has(command.id) || byId.has(command.id)) {
          warn(`[palette] 命令 id 重复："${command.id}"，后注册的覆盖先注册的`)
        }
        ids.add(command.id)
      }
      const token = Symbol('palette-registration')
      entries = [...entries, { token, commands: [...commands] }]
      rebuild()
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        entries = entries.filter((entry) => entry.token !== token)
        rebuild()
      }
    },
    getCommands: () => snapshot,
    get: (id) => byId.get(id),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** 应用级单例：App、各 feature 都往这里登记。 */
export const commandRegistry = createCommandRegistry()

export function registerCommands(commands: readonly PaletteCommand[]): () => void {
  return commandRegistry.register(commands)
}

/** 订阅当前全部已登记命令（未按 when 过滤）。 */
export function useCommands(registry: CommandRegistry = commandRegistry): readonly PaletteCommand[] {
  return useSyncExternalStore(registry.subscribe, registry.getCommands, registry.getCommands)
}
