/**
 * 终端底部快捷键栏（参考手机端 mobile/android/web/keyLayout.js）：纯逻辑，无 DOM。
 *
 * - 内置键：电脑有实体键盘，默认只显示鼠标点更顺手的 Esc / ^C / ⇧Tab / 清除输入，
 *   Tab、方向键等默认隐藏（移入「⋯」菜单），可在设置中打开。
 * - 自定义键：键名 + 发送的文本，可选发送后回车（隔 250ms 再发，避免 TUI 把回车当作粘贴的一部分），
 *   可选绑定一个仅在终端内生效的快捷键。
 * - 内置键可以删除（记入 removed，解析时不再按「新版本新增键」补回），可单独加回或「恢复默认」。
 * - 布局（顺序 / 隐藏 / 已删除内置键 / 自定义键）与折叠状态保存在本机 localStorage，随「导出配置」一起导出。
 */
import { canonicalizeShortcut, isShortcutBound } from '@/lib/shortcuts'

export type TerminalShortcutBuiltinKey =
  | 'esc'
  | 'interrupt'
  | 'shift-tab'
  | 'clear-input'
  | 'tab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pgup'
  | 'pgdn'
  | 'backspace'

export interface TerminalShortcutKeyInfo {
  key: TerminalShortcutBuiltinKey
  /** 按钮上的文字（方向键等由组件换成图标）。 */
  label: string
  /** 设置列表与提示里的名称（参与翻译）。 */
  name: string
  /** 默认隐藏到「⋯」菜单。 */
  defaultHidden?: boolean
  /** 按住连发（方向键、退格、翻页）。 */
  repeat?: boolean
}

/** 内置键默认顺序：前四个默认显示，其余默认隐藏。 */
export const TERMINAL_SHORTCUT_KEYS: readonly TerminalShortcutKeyInfo[] = Object.freeze([
  { key: 'esc', label: 'Esc', name: 'Esc' },
  { key: 'interrupt', label: '^C', name: 'Ctrl+C（中断）' },
  { key: 'shift-tab', label: '⇧Tab', name: 'Shift+Tab' },
  { key: 'clear-input', label: '清除输入', name: '清除终端输入' },
  { key: 'tab', label: 'Tab', name: 'Tab', defaultHidden: true },
  { key: 'up', label: '↑', name: '向上', defaultHidden: true, repeat: true },
  { key: 'down', label: '↓', name: '向下', defaultHidden: true, repeat: true },
  { key: 'left', label: '←', name: '向左', defaultHidden: true, repeat: true },
  { key: 'right', label: '→', name: '向右', defaultHidden: true, repeat: true },
  { key: 'home', label: 'Home', name: 'Home', defaultHidden: true },
  { key: 'end', label: 'End', name: 'End', defaultHidden: true },
  { key: 'pgup', label: 'PgUp', name: 'PgUp', defaultHidden: true, repeat: true },
  { key: 'pgdn', label: 'PgDn', name: 'PgDn', defaultHidden: true, repeat: true },
  { key: 'backspace', label: '⌫', name: '退格', defaultHidden: true, repeat: true },
])

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
  /** 用户删除的内置键（不在 order 中）。 */
  removed: string[]
  /** 全局折叠状态：所有终端格子一起收起 / 展开。 */
  collapsed: boolean
}

const BUILTIN = new Set<string>(TERMINAL_SHORTCUT_KEYS.map(item => item.key))
const DEFAULT_HIDDEN = TERMINAL_SHORTCUT_KEYS.filter(item => item.defaultHidden).map(item => item.key)

export function isBuiltinShortcutKey(key: string): key is TerminalShortcutBuiltinKey {
  return BUILTIN.has(key)
}

export function isCustomShortcutKey(key: string): boolean {
  return key.startsWith(CUSTOM_KEY_PREFIX)
}

export function customKeyLayoutId(id: string): string {
  return CUSTOM_KEY_PREFIX + id
}

export function builtinKeyInfo(key: string): TerminalShortcutKeyInfo | undefined {
  return TERMINAL_SHORTCUT_KEYS.find(item => item.key === key)
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
  return {
    order: [...TERMINAL_SHORTCUT_KEYS.map(item => item.key), ...custom.map(def => customKeyLayoutId(def.id))],
    hidden: [...DEFAULT_HIDDEN],
    custom,
  }
}

export function defaultShortcutBarState(): TerminalShortcutBarState {
  return { ...defaultShortcutLayout(), removed: [], collapsed: false }
}

/**
 * 解析保存的状态：丢弃未知键和重复项；新版本新增的内置键按默认位置补回，
 * 且按默认可见性处理（之前没保存过的键不会被当成「用户显示过」）；损坏或缺失时返回默认。
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
  const valid = (key: unknown): key is string =>
    typeof key === 'string' && (BUILTIN.has(key) || customKeys.has(key))
  const removed = Array.isArray(value.removed)
    ? [...new Set(value.removed.filter((key): key is string => typeof key === 'string' && BUILTIN.has(key)))]
    : []
  const order = [...new Set((value.order as unknown[]).filter(valid))].filter(key => !removed.includes(key))
  const added: string[] = []
  for (const { key } of TERMINAL_SHORTCUT_KEYS) {
    if (order.includes(key) || removed.includes(key)) continue
    added.push(key)
    insertBuiltinKey(order, key)
  }
  for (const key of customKeys) if (!order.includes(key)) order.push(key)
  const hidden = (Array.isArray(value.hidden) ? [...new Set(value.hidden.filter(valid))] : [...DEFAULT_HIDDEN])
    .filter(key => !removed.includes(key))
  for (const key of added) if (DEFAULT_HIDDEN.includes(key as TerminalShortcutBuiltinKey) && !hidden.includes(key)) hidden.push(key)
  return { order, hidden, removed, custom, collapsed: value.collapsed === true }
}

/** 把内置键插到默认顺序中前一个已存在键之后，保持用户已有的相对顺序（原地修改 order）。 */
function insertBuiltinKey(order: string[], key: string) {
  const index = TERMINAL_SHORTCUT_KEYS.findIndex(item => item.key === key)
  const before = TERMINAL_SHORTCUT_KEYS.slice(0, index)
    .map(item => item.key)
    .reverse()
    .find(previous => order.includes(previous))
  order.splice(before ? order.indexOf(before) + 1 : 0, 0, key)
}

/** 删除内置键：从栏和「⋯」中移除，记入 removed；非内置键或已删除时原样返回。 */
export function removeBuiltinKey<T extends TerminalShortcutBarState>(state: T, key: string): T {
  if (!BUILTIN.has(key) || state.removed.includes(key)) return state
  return {
    ...state,
    order: state.order.filter(item => item !== key),
    hidden: state.hidden.filter(item => item !== key),
    removed: [...state.removed, key],
  }
}

/** 删除全部内置键：栏里只剩自定义键。 */
export function removeAllBuiltinKeys<T extends TerminalShortcutBarState>(state: T): T {
  return {
    ...state,
    order: state.order.filter(key => !BUILTIN.has(key)),
    hidden: state.hidden.filter(key => !BUILTIN.has(key)),
    removed: TERMINAL_SHORTCUT_KEYS.map(item => item.key),
  }
}

/** 加回已删除的内置键：放回默认位置附近并显示在栏中。 */
export function restoreBuiltinKey<T extends TerminalShortcutBarState>(state: T, key: string): T {
  if (!state.removed.includes(key)) return state
  const order = [...state.order]
  if (!order.includes(key)) insertBuiltinKey(order, key)
  return {
    ...state,
    order,
    hidden: state.hidden.filter(item => item !== key),
    removed: state.removed.filter(item => item !== key),
  }
}

export function serializeShortcutBarState(state: TerminalShortcutBarState): string {
  return JSON.stringify({
    order: state.order,
    hidden: state.hidden,
    removed: state.removed,
    custom: state.custom,
    collapsed: state.collapsed,
  })
}

/** 内置键的顺序与可见性是否为默认（自定义键不计入）。 */
export function isDefaultShortcutLayout(layout: TerminalShortcutLayout): boolean {
  const defaults = defaultShortcutLayout(layout.custom)
  const hidden = new Set(layout.hidden)
  return (
    layout.order.length === defaults.order.length &&
    layout.order.every((key, index) => key === defaults.order[index]) &&
    hidden.size === defaults.hidden.length &&
    defaults.hidden.every(key => hidden.has(key))
  )
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
  if (!BUILTIN.has(key) && !findCustomKey(layout, key)) return layout
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

const ARROWS: Partial<Record<TerminalShortcutBuiltinKey, string>> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
  home: 'H',
  end: 'F',
}

/**
 * 内置键对应写入 PTY 的序列；`clear-input` 依赖 Shell 与输入框状态，由终端组件单独生成
 * （terminalClearInput.ts），这里返回 null。
 */
export function builtinKeySequence(
  key: TerminalShortcutBuiltinKey,
  { applicationCursor = false }: { applicationCursor?: boolean } = {},
): string | null {
  switch (key) {
    case 'esc':
      return '\x1b'
    case 'interrupt':
      return '\x03'
    case 'shift-tab':
      return '\x1b[Z'
    case 'tab':
      return '\t'
    case 'backspace':
      return '\x7f'
    case 'pgup':
      return '\x1b[5~'
    case 'pgdn':
      return '\x1b[6~'
    case 'clear-input':
      return null
    default: {
      const final = ARROWS[key]
      return final ? (applicationCursor ? '\x1bO' : '\x1b[') + final : null
    }
  }
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
