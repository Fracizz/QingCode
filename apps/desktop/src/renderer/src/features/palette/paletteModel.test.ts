import { describe, expect, it, vi } from 'vitest'
import {
  RECENT_MAX,
  executeCommand,
  formatShortcut,
  isVisible,
  moveSelection,
  normalizeQuery,
  parseRecent,
  pushRecent,
  rankCommands,
} from './paletteModel'
import type { PaletteCommand } from './types'

const cmd = (id: string, title: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({
  id,
  title,
  run: () => {},
  ...extra,
})

describe('normalizeQuery', () => {
  it('去掉开头的 > 与空白', () => {
    expect(normalizeQuery('> 设置')).toBe('设置')
    expect(normalizeQuery('  >git ')).toBe('git')
    expect(normalizeQuery('a>b')).toBe('a>b')
  })
})

describe('最近使用', () => {
  it('pushRecent 置顶去重并截断', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    const many = Array.from({ length: RECENT_MAX }, (_, i) => `c${i}`)
    const next = pushRecent(many, 'new')
    expect(next).toHaveLength(RECENT_MAX)
    expect(next[0]).toBe('new')
    expect(next).not.toContain(`c${RECENT_MAX - 1}`)
  })

  it('parseRecent 容错', () => {
    expect(parseRecent(null)).toEqual([])
    expect(parseRecent('not json')).toEqual([])
    expect(parseRecent('{"a":1}')).toEqual([])
    expect(parseRecent('["a",1,"b","a",""]')).toEqual(['a', 'b'])
    expect(parseRecent(JSON.stringify(Array.from({ length: 30 }, (_, i) => `x${i}`)))).toHaveLength(RECENT_MAX)
  })
})

describe('formatShortcut', () => {
  it('统一为 Windows 风格', () => {
    expect(formatShortcut('ctrl+shift+p')).toBe('Ctrl+Shift+P')
    expect(formatShortcut('shift+mod+p')).toBe('Ctrl+Shift+P')
    expect(formatShortcut('Ctrl Shift E')).toBe('Ctrl+Shift+E')
    expect(formatShortcut('Ctrl + ,')).toBe('Ctrl+,')
    expect(formatShortcut('f1')).toBe('F1')
    expect(formatShortcut('alt+ctrl+arrowup')).toBe('Ctrl+Alt+↑')
    expect(formatShortcut('ctrl++')).toBe('Ctrl++')
  })

  it('支持组合序列，空值返回空串', () => {
    expect(formatShortcut('ctrl+k ctrl+s')).toBe('Ctrl+K Ctrl+S')
    expect(formatShortcut(undefined)).toBe('')
    expect(formatShortcut('')).toBe('')
  })
})

describe('isVisible', () => {
  it('when 为假或抛错时隐藏', () => {
    expect(isVisible(cmd('a', 'A'))).toBe(true)
    expect(isVisible(cmd('a', 'A', { when: () => false }))).toBe(false)
    expect(
      isVisible(
        cmd('a', 'A', {
          when: () => {
            throw new Error('boom')
          },
        }),
      ),
    ).toBe(false)
  })
})

describe('rankCommands', () => {
  const commands = [
    cmd('settings', '打开设置', { category: '设置' }),
    cmd('sidebar', '切换侧栏', { category: '视图' }),
    cmd('explorer', '切换资源管理器', { category: '视图', keywords: ['explorer'] }),
    cmd('hidden', '隐藏命令', { when: () => false }),
    cmd('bare', '无分类命令'),
    cmd('new', '新建会话', { category: '会话' }),
  ]

  it('空查询：最近使用在前，其余按分类、标题，无分类在最后', () => {
    const ids = rankCommands(commands, '', ['sidebar', 'missing', 'settings']).map((item) => item.command.id)
    expect(ids.slice(0, 2)).toEqual(['sidebar', 'settings'])
    expect(ids).not.toContain('hidden')
    expect(ids[ids.length - 1]).toBe('bare')
    expect(ids).toHaveLength(5)
  })

  it('空查询时最近使用项带 recent 标记，仅有 > 也视为空查询', () => {
    const ranked = rankCommands(commands, '>', ['new'])
    expect(ranked[0]).toMatchObject({ recent: true, command: { id: 'new' } })
    expect(ranked.filter((item) => item.recent)).toHaveLength(1)
  })

  it('有查询时按匹配分排序并过滤', () => {
    const ranked = rankCommands(commands, '切换', [])
    expect(ranked.map((item) => item.command.id).sort()).toEqual(['explorer', 'sidebar'])
    expect(ranked[0]!.titlePositions).toEqual([0, 1])
  })

  it('同分时最近使用优先', () => {
    const a = rankCommands(commands, '切换', ['explorer']).map((item) => item.command.id)
    const b = rankCommands(commands, '切换', ['sidebar']).map((item) => item.command.id)
    expect(a[0]).toBe('explorer')
    expect(b[0]).toBe('sidebar')
  })

  it('关键字命中，when 为假的不出现', () => {
    expect(rankCommands(commands, '> explorer', []).map((item) => item.command.id)).toEqual(['explorer'])
    expect(rankCommands(commands, '隐藏', [])).toEqual([])
  })
})

describe('moveSelection', () => {
  it('上下循环，翻页夹边界', () => {
    expect(moveSelection(0, 5, 'up', 10)).toBe(4)
    expect(moveSelection(4, 5, 'down', 10)).toBe(0)
    expect(moveSelection(2, 30, 'pageDown', 10)).toBe(12)
    expect(moveSelection(25, 30, 'pageDown', 10)).toBe(29)
    expect(moveSelection(5, 30, 'pageUp', 10)).toBe(0)
    expect(moveSelection(5, 30, 'home', 10)).toBe(0)
    expect(moveSelection(5, 30, 'end', 10)).toBe(29)
    expect(moveSelection(3, 0, 'down', 10)).toBe(0)
  })
})

describe('executeCommand', () => {
  it('成功返回 true，不调用 onError', async () => {
    const onError = vi.fn()
    expect(await executeCommand(cmd('a', 'A'), onError)).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it('同步抛错与异步拒绝都收敛到 onError', async () => {
    const onError = vi.fn()
    const sync = cmd('s', '同步', {
      run: () => {
        throw new Error('坏了')
      },
    })
    const async = cmd('a', '异步', { run: () => Promise.reject(new Error('超时')) })
    expect(await executeCommand(sync, onError)).toBe(false)
    expect(await executeCommand(async, onError)).toBe(false)
    expect(onError).toHaveBeenNthCalledWith(1, '命令"同步"执行失败：坏了', sync)
    expect(onError).toHaveBeenNthCalledWith(2, '命令"异步"执行失败：超时', async)
  })
})
