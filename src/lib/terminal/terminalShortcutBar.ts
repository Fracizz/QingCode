/**
 * 终端底部快捷键栏（参考手机端 mobile/android/web/keyLayout.js）：纯逻辑，无 DOM。
 *
 * - 电脑有实体键盘，不再提供内置键（Esc / ^C 等），栏中只有用户添加的自定义键。
 * - 自定义键：键名 + 发送的文本，可选发送后回车（隔 250ms 再发，避免 TUI 把回车当作粘贴的一部分），
 *   可选绑定一个仅在终端内生效的快捷键。
 * - 布局（顺序 / 隐藏 / 自定义键）与折叠状态保存在本机 localStorage，随「导出配置」一起导出；
 *   旧版本保存的内置键在解析时丢弃。
 */
import { canonicalizeShortcut, isShortcutBound } from '@/lib/shortcuts'

export const CUSTOM_KEY_PREFIX = 'custom:'
export const CUSTOM_KEY_NAME_LIMIT = 24
export const CUSTOM_KEY_TEXT_LIMIT = 200
export const CUSTOM_KEY_LIMIT = 30
/** 自定义键的回车与文本分开发送的间隔（与手机端一致）。 */
export const CUSTOM_KEY_ENTER_DELAY_MS = 250

export interface TerminalCustomKey {
  id: string
  /** 按钮名称；为空时按钮显示发送的文本。 */
  name: string
  /** 发送的文本：单行，不含控制字符。 */
  text: string
  /** 发送后回车。 */
  enter: boolean
  /** 终端内快捷键（规范化形式，如 `Ctrl+Alt+1`）；空串为未绑定。 */
  shortcut: string
}

export interface TerminalShortcutLayout {
  order: string[]
  hidden: string[]
  custom: TerminalCustomKey[]
}

export interface TerminalShortcutBarState extends TerminalShortcutLayout {
  /** 全局折叠状态：所有终端格子一起收起 / 展开。 */
  collapsed: boolean
}

export function isCustomShortcutKey(key: string): boolean {
  return key.startsWith(CUSTOM_KEY_PREFIX)
}

export function customKeyLayoutId(id: string): string {
  return CUSTOM_KEY_PREFIX + id
}

export function findCustomKey(layout: TerminalShortcutLayout, key: string): TerminalCustomKey | null {
  const id = isCustomShortcutKey(key) ? key.slice(CUSTOM_KEY_PREFIX.length) : key
  return layout.custom.find(def => def.id === id) ?? null
}

/**
 * 校验并规整一个自定义键；无效时返回 null。
 * 文本原样保留首尾空格（如 `git commit -m ` 依赖结尾空格），但不能全是空白，不允许换行和控制字符。
 */
export function normalizeCustomKey(raw: unknown): TerminalCustomKey | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value.id) ? value.id : null
  if (!id || typeof value.text !== 'string') return null
  const text = value.text
  if (!text.trim() || text.length > CUSTOM_KEY_TEXT_LIMIT || /[\x00-\x1f\x7f]/.test(text)) return null
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, CUSTOM_KEY_NAME_LIMIT) : ''
  const shortcut =
    typeof value.shortcut === 'string' && isShortcutBound(value.shortcut)
      ? canonicalizeShortcut(value.shortcut.trim())
      : ''
  return { id, name, text, enter: value.enter !== false, shortcut }
}

/** 按钮文字：有名称用名称，否则用发送的文本。 */
export function customKeyLabel(def: TerminalCustomKey): string {
  return def.name || def.text
}

/** 说明文字：实际发送的内容，回车用 ↵ 表示。 */
export function customKeyDetail(def: TerminalCustomKey): string {
  return def.enter ? `${def.text} ↵` : def.text
}

/** 按下自定义键时写入终端的内容：先写 data，enter 非空时隔 {@link CUSTOM_KEY_ENTER_DELAY_MS} 再写。 */
export function customKeyInput(def: TerminalCustomKey): { data: string; enter: string } {
  return { data: def.text, enter: def.enter ? '\r' : '' }
}

export function defaultShortcutLayout(custom: TerminalCustomKey[] = []): TerminalShortcutLayout {
  return { order: custom.map(def => customKeyLayoutId(def.id)), hidden: [], custom }
}

export function defaultShortcutBarState(): TerminalShortcutBarState {
  return { ...defaultShortcutLayout(), collapsed: false }
}

/**
 * 解析保存的状态：丢弃未知键（含旧版本的内置键）和重复项，漏在 order 外的自定义键补到末尾；
 * 损坏或缺失时返回默认（空栏）。
 */
export function parseShortcutBarState(raw: unknown): TerminalShortcutBarState {
  let saved: unknown
  try {
    saved = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return defaultShortcutBarState()
  }
  if (!saved || typeof saved !== 'object' || !Array.isArray((saved as { order?: unknown }).order)) {
    return defaultShortcutBarState()
  }
  const value = saved as Record<string, unknown>
  const custom: TerminalCustomKey[] = []
  for (const item of Array.isArray(value.custom) ? value.custom : []) {
    const def = normalizeCustomKey(item)
    if (def && custom.length < CUSTOM_KEY_LIMIT && !custom.some(other => other.id === def.id)) custom.push(def)
  }
  const customKeys = new Set(custom.map(def => customKeyLayoutId(def.id)))
  const valid = (key: unknown): key is string => typeof key === 'string' && customKeys.has(key)
  const order = [...new Set((value.order as unknown[]).filter(valid))]
  for (const key of customKeys) if (!order.includes(key)) order.push(key)
  const hidden = Array.isArray(value.hidden) ? [...new Set(value.hidden.filter(valid))] : []
  return { order, hidden, custom, collapsed: value.collapsed === true }
}

export function serializeShortcutBarState(state: TerminalShortcutBarState): string {
  return JSON.stringify({
    order: state.order,
    hidden: state.hidden,
    custom: state.custom,
    collapsed: state.collapsed,
  })
}

/** 新建自定义键的 id：与已有 id 不重复。 */
export function newCustomKeyId(layout: TerminalShortcutLayout, random: () => number = Math.random): string {
  for (;;) {
    const id = 'k' + Math.floor(random() * 36 ** 6).toString(36)
    if (!layout.custom.some(def => def.id === id)) return id
  }
}

/** 添加或修改自定义键：新键排到最后并显示在栏中；无效或超过数量上限时原样返回。 */
export function saveCustomKey<T extends TerminalShortcutLayout>(layout: T, raw: unknown): T {
  const def = normalizeCustomKey(raw)
  if (!def) return layout
  const index = layout.custom.findIndex(item => item.id === def.id)
  if (index >= 0) {
    const custom = [...layout.custom]
    custom[index] = def
    return { ...layout, custom }
  }
  if (layout.custom.length >= CUSTOM_KEY_LIMIT) return layout
  return { ...layout, custom: [...layout.custom, def], order: [...layout.order, customKeyLayoutId(def.id)] }
}

export function removeCustomKey<T extends TerminalShortcutLayout>(layout: T, id: string): T {
  const key = customKeyLayoutId(id)
  if (!layout.custom.some(def => def.id === id)) return layout
  return {
    ...layout,
    order: layout.order.filter(item => item !== key),
    hidden: layout.hidden.filter(item => item !== key),
    custom: layout.custom.filter(def => def.id !== id),
  }
}

/** 上移（delta = -1）或下移（delta = 1）一位；越界时原样返回。 */
export function moveShortcutKey<T extends TerminalShortcutLayout>(layout: T, key: string, delta: number): T {
  const from = layout.order.indexOf(key)
  const to = from + delta
  if (from < 0 || to < 0 || to >= layout.order.length) return layout
  const order = [...layout.order]
  ;[order[from], order[to]] = [order[to], order[from]]
  return { ...layout, order }
}

/** 拖拽排序：把 source 放到 target 之前或之后；任一不存在或相同时原样返回。 */
export function reorderShortcutKey<T extends TerminalShortcutLayout>(
  layout: T,
  source: string,
  target: string,
  position: 'before' | 'after',
): T {
  if (source === target || !layout.order.includes(source) || !layout.order.includes(target)) return layout
  const order = layout.order.filter(key => key !== source)
  const index = order.indexOf(target) + (position === 'after' ? 1 : 0)
  order.splice(index, 0, source)
  return { ...layout, order }
}

export function toggleShortcutKeyHidden<T extends TerminalShortcutLayout>(layout: T, key: string): T {
  if (!findCustomKey(layout, key)) return layout
  const hidden = layout.hidden.includes(key)
    ? layout.hidden.filter(item => item !== key)
    : [...layout.hidden, key]
  return { ...layout, hidden }
}

/** 栏中显示的键与隐藏到「⋯」菜单的键，均按布局顺序。 */
export function visibleShortcutKeys(layout: TerminalShortcutLayout): { bar: string[]; overflow: string[] } {
  const hidden = new Set(layout.hidden)
  return {
    bar: layout.order.filter(key => !hidden.has(key)),
    overflow: layout.order.filter(key => hidden.has(key)),
  }
}

/**
 * 按宽度决定栏内放几个键：widths 为各键按钮宽度，available 为可用宽度（已扣除「⋯」与折叠按钮），
 * gap 为按钮间距。至少返回 0，按顺序放到放不下为止。
 */
export function fitShortcutKeyCount(widths: number[], available: number, gap: number): number {
  let used = 0
  for (let index = 0; index < widths.length; index++) {
    const next = used + (index > 0 ? gap : 0) + widths[index]
    if (next > available) return index
    used = next
  }
  return widths.length
}

/** 按终端内快捷键查找自定义键（shortcut 为规范化形式）。 */
export function customKeyForShortcut(layout: TerminalShortcutLayout, shortcut: string | null): TerminalCustomKey | null {
  if (!shortcut) return null
  const canonical = canonicalizeShortcut(shortcut)
  return layout.custom.find(def => def.shortcut && def.shortcut === canonical) ?? null
}

/** 终端自身依赖的组合（复制 / 粘贴 / 中断 / 换行 / 查找），不能分配给自定义键。 */
export const TERMINAL_RESERVED_SHORTCUTS = [
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+Shift+C',
  'Ctrl+Shift+V',
  'Ctrl+Enter',
  'Shift+Enter',
  'Ctrl+F',
] as const

/**
 * 自定义键快捷键与终端保留组合、其他自定义键的冲突；应用快捷键与编辑器保留键由调用方另行检查。
 */
export function customShortcutConflict(
  layout: TerminalShortcutLayout,
  id: string,
  shortcut: string,
): { kind: 'terminal' } | { kind: 'custom'; key: TerminalCustomKey } | null {
  const canonical = canonicalizeShortcut(shortcut)
  if (TERMINAL_RESERVED_SHORTCUTS.some(item => canonicalizeShortcut(item) === canonical)) return { kind: 'terminal' }
  const other = layout.custom.find(def => def.id !== id && def.shortcut === canonical)
  return other ? { kind: 'custom', key: other } : null
}
