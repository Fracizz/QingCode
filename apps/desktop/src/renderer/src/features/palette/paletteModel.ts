import { getLocale, t, translateMessage } from '@qn/codex-client'
import { matchCommandText } from './match'
import type { PaletteCommand } from './types'

// 面板的纯逻辑：查询解析、最近使用、排序、快捷键显示、命令执行的错误收敛。

export const RECENT_MAX = 20

/** 与旧版一致：`>` 开头视为命令模式；本面板默认就是命令模式，`>` 只被去掉。 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/^\s*>/, '').trim()
}

export function parseRecent(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const ids = value.filter((item): item is string => typeof item === 'string' && item !== '')
    return [...new Set(ids)].slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

export function pushRecent(list: readonly string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...list.filter((item) => item !== id)].slice(0, max)
}

const KEY_NAMES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  mod: 'Ctrl',
  cmd: 'Ctrl',
  meta: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  win: 'Win',
  esc: 'Esc',
  escape: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: '↑',
  arrowup: '↑',
  down: '↓',
  arrowdown: '↓',
  left: '←',
  arrowleft: '←',
  right: '→',
  arrowright: '→',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
}

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt', 'Win']

/**
 * 统一成 Windows 风格 `Ctrl+Shift+P`：修饰键固定顺序，字母大写。
 * 支持用空白分隔的组合序列（如 "ctrl+k ctrl+s" → "Ctrl+K Ctrl+S"）。
 */
export function formatShortcut(raw: string | undefined): string {
  if (!raw) return ''
  // "+" 本身作按键时（ctrl++）先占位，避免被当成分隔符
  const chords = raw
    .trim()
    .replace(/\s*\+\s*/g, '+')
    .replace(/\+\+/g, '+plus')
    .split(/\s+/)
    .filter(Boolean)
  // 兼容 "Ctrl Shift P" 这种整串空白分隔的写法：除最后一个外都是修饰键时合成一个组合
  const allSpaceSeparated =
    chords.length > 1 &&
    chords.every((chord) => !chord.includes('+')) &&
    chords.slice(0, -1).every((chord) => MODIFIER_ORDER.includes(KEY_NAMES[chord.toLowerCase()] ?? ''))
  const groups = allSpaceSeparated ? [chords.join('+')] : chords
  return groups
    .map((chord) => {
      const parts = chord.split('+').filter(Boolean).map((part) => {
        if (part === 'plus') return '+'
        const named = KEY_NAMES[part.toLowerCase()]
        if (named) return named
        if (/^f\d{1,2}$/i.test(part)) return part.toUpperCase()
        return part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)
      })
      const modifiers = MODIFIER_ORDER.filter((mod) => parts.includes(mod))
      const keys = parts.filter((part) => !MODIFIER_ORDER.includes(part))
      return [...modifiers, ...keys].join('+')
    })
    .join(' ')
}

export function isVisible(command: PaletteCommand): boolean {
  if (!command.when) return true
  try {
    return command.when() !== false
  } catch {
    return false
  }
}

export type RankedCommand = {
  command: PaletteCommand
  score: number
  titlePositions: number[]
  categoryPositions: number[]
  recent: boolean
}

const collator = new Intl.Collator(getLocale() === 'en' ? 'en-US' : 'zh-CN', { numeric: true, sensitivity: 'base' })

const byCategoryThenTitle = (a: PaletteCommand, b: PaletteCommand): number => {
  // 无分类的命令排在有分类的之后
  if (!a.category !== !b.category) return a.category ? -1 : 1
  return collator.compare(a.category ?? '', b.category ?? '') || collator.compare(a.title, b.title)
}

/**
 * 过滤并排序：`when()` 为假的不出现；
 * 空查询时最近使用在前（按使用先后），其余按分类、标题排序；
 * 有查询时按匹配分降序，同分时最近使用优先，再按分类、标题。
 */
export function rankCommands(
  commands: readonly PaletteCommand[],
  rawQuery: string,
  recentIds: readonly string[],
): RankedCommand[] {
  const query = normalizeQuery(rawQuery)
  const recentRank = new Map(recentIds.map((id, index) => [id, index]))
  const visible = commands.filter(isVisible)

  if (!query) {
    const recent = visible
      .filter((command) => recentRank.has(command.id))
      .sort((a, b) => recentRank.get(a.id)! - recentRank.get(b.id)!)
    const rest = visible.filter((command) => !recentRank.has(command.id)).sort(byCategoryThenTitle)
    return [
      ...recent.map((command) => ({ command, score: 0, titlePositions: [], categoryPositions: [], recent: true })),
      ...rest.map((command) => ({ command, score: 0, titlePositions: [], categoryPositions: [], recent: false })),
    ]
  }

  const ranked: RankedCommand[] = []
  for (const command of visible) {
    const match = matchCommandText(command, query)
    if (match) ranked.push({ command, ...match, recent: recentRank.has(command.id) })
  }
  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ra = recentRank.get(a.command.id) ?? Number.POSITIVE_INFINITY
    const rb = recentRank.get(b.command.id) ?? Number.POSITIVE_INFINITY
    if (ra !== rb) return ra - rb
    return byCategoryThenTitle(a.command, b.command)
  })
}

/** 键盘移动选中项：上下键循环，PageUp/PageDown/Home/End 夹在边界内。 */
export function moveSelection(
  current: number,
  count: number,
  key: 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize: number,
): number {
  if (count <= 0) return 0
  const page = Math.max(1, pageSize)
  switch (key) {
    case 'up':
      return current <= 0 ? count - 1 : current - 1
    case 'down':
      return current >= count - 1 ? 0 : current + 1
    case 'pageUp':
      return Math.max(0, current - page)
    case 'pageDown':
      return Math.min(count - 1, current + page)
    case 'home':
      return 0
    case 'end':
      return count - 1
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return translateMessage(err.message)
  if (typeof err === 'string' && err) return translateMessage(err)
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message) {
    return translateMessage(err.message)
  }
  return t('未知错误')
}

/** 运行命令并把同步抛错与异步拒绝都收敛到 onError，调用方无需 try/catch。 */
export async function executeCommand(
  command: PaletteCommand,
  onError: (message: string, command: PaletteCommand) => void,
): Promise<boolean> {
  try {
    await command.run()
    return true
  } catch (err) {
    onError(t('命令"{title}"执行失败：{message}', { title: command.title, message: errorMessage(err) }), command)
    return false
  }
}
