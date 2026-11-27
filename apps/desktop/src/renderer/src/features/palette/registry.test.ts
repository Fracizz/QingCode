import { describe, expect, it, vi } from 'vitest'
import { createCommandRegistry } from './registry'
import type { PaletteCommand } from './types'

const cmd = (id: string, title = id): PaletteCommand => ({ id, title, run: () => {} })

describe('createCommandRegistry', () => {
  it('登记与注销', () => {
    const registry = createCommandRegistry({ warn: () => {} })
    const off = registry.register([cmd('a'), cmd('b')])
    expect(registry.getCommands().map((c) => c.id)).toEqual(['a', 'b'])
    off()
    expect(registry.getCommands()).toEqual([])
    off() // 重复注销无副作用
    expect(registry.getCommands()).toEqual([])
  })

  it('重复 id 后注册覆盖先注册并告警，注销后先注册的恢复', () => {
    const warn = vi.fn()
    const registry = createCommandRegistry({ warn })
    registry.register([cmd('a', '旧'), cmd('b')])
    const off = registry.register([cmd('a', '新')])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('"a"')
    // 位置保持首次登记顺序
    expect(registry.getCommands().map((c) => c.title)).toEqual(['新', 'b'])
    expect(registry.get('a')?.title).toBe('新')
    off()
    expect(registry.get('a')?.title).toBe('旧')
  })

  it('同一批里重复 id 也告警', () => {
    const warn = vi.fn()
    createCommandRegistry({ warn }).register([cmd('x'), cmd('x')])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('快照引用稳定，变化时通知订阅者', () => {
    const registry = createCommandRegistry({ warn: () => {} })
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const before = registry.getCommands()
    expect(registry.getCommands()).toBe(before)
    const off = registry.register([cmd('a')])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(registry.getCommands()).not.toBe(before)
    unsubscribe()
    off()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
