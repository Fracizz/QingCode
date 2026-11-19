import { describe, expect, it } from 'vitest'
import {
  CUSTOM_KEY_LIMIT,
  TERMINAL_SHORTCUT_KEYS,
  builtinKeySequence,
  customKeyDetail,
  customKeyForShortcut,
  customKeyInput,
  customKeyLabel,
  customShortcutConflict,
  defaultShortcutBarState,
  defaultShortcutLayout,
  fitShortcutKeyCount,
  isDefaultShortcutLayout,
  moveShortcutKey,
  newCustomKeyId,
  normalizeCustomKey,
  parseShortcutBarState,
  removeCustomKey,
  saveCustomKey,
  serializeShortcutBarState,
  toggleShortcutKeyHidden,
  visibleShortcutKeys,
} from './terminalShortcutBar'

const custom = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: '', text: `/${id}`, enter: true, shortcut: '', ...extra })

describe('terminalShortcutBar defaults', () => {
  it('shows only mouse-friendly keys by default and hides keyboard keys', () => {
    const { bar, overflow } = visibleShortcutKeys(defaultShortcutLayout())
    expect(bar).toEqual(['esc', 'interrupt', 'shift-tab', 'clear-input'])
    expect(overflow).toContain('up')
    expect(overflow).toContain('tab')
    expect(overflow.length + bar.length).toBe(TERMINAL_SHORTCUT_KEYS.length)
  })

  it('defaults to expanded', () => {
    expect(defaultShortcutBarState().collapsed).toBe(false)
  })
})

describe('parseShortcutBarState', () => {
  it('falls back to defaults for missing or broken data', () => {
    expect(parseShortcutBarState(null)).toEqual(defaultShortcutBarState())
    expect(parseShortcutBarState('{bad')).toEqual(defaultShortcutBarState())
    expect(parseShortcutBarState({ order: 'x' })).toEqual(defaultShortcutBarState())
  })

  it('drops unknown and duplicate keys and keeps collapsed', () => {
    const state = parseShortcutBarState({
      order: ['interrupt', 'esc', 'bogus', 'esc', 'custom:missing'],
      hidden: ['esc', 'bogus'],
      collapsed: true,
    })
    expect(state.order.filter(key => key === 'interrupt' || key === 'esc')).toEqual(['interrupt', 'esc'])
    expect(new Set(state.order).size).toBe(state.order.length)
    expect(state.order).not.toContain('bogus')
    expect(state.hidden).toContain('esc')
    expect(state.collapsed).toBe(true)
  })

  it('adds keys introduced later after their default predecessor with default visibility', () => {
    const state = parseShortcutBarState({ order: ['shift-tab', 'esc'], hidden: [] })
    // interrupt 默认在 esc 之后；clear-input 在 shift-tab 之后。
    expect(state.order.indexOf('interrupt')).toBe(state.order.indexOf('esc') + 1)
    expect(state.order.indexOf('clear-input')).toBe(state.order.indexOf('shift-tab') + 1)
    expect(state.hidden).toContain('up')
    expect(state.hidden).not.toContain('interrupt')
  })

  it('keeps valid custom keys and appends them when missing from order', () => {
    const state = parseShortcutBarState({
      order: ['esc'],
      hidden: [],
      custom: [custom('a'), custom('a'), { id: 'bad id', text: 'x' }, custom('b', { text: 'line\nbreak' })],
    })
    expect(state.custom.map(def => def.id)).toEqual(['a'])
    expect(state.order).toContain('custom:a')
  })

  it('round-trips through serialize', () => {
    const state = saveCustomKey({ ...defaultShortcutBarState(), collapsed: true }, custom('x', { shortcut: 'alt+ctrl+1' }))
    expect(parseShortcutBarState(serializeShortcutBarState(state))).toEqual(state)
  })
})

describe('custom keys', () => {
  it('normalizes text, name and shortcut', () => {
    expect(normalizeCustomKey({ id: 'k1', text: '  /compact ', name: ' 压缩 ', shortcut: 'Alt+Ctrl+1' })).toEqual({
      id: 'k1', name: '压缩', text: '/compact', enter: true, shortcut: 'Ctrl+Alt+1',
    })
    expect(normalizeCustomKey({ id: 'k1', text: '   ' })).toBeNull()
    expect(normalizeCustomKey({ id: 'k1', text: 'a\tb' })).toBeNull()
    expect(normalizeCustomKey({ id: 'k1', text: 'x'.repeat(201) })).toBeNull()
    expect(normalizeCustomKey({ id: 'k1', text: 'ls', enter: false })?.enter).toBe(false)
  })

  it('formats labels and input', () => {
    const def = normalizeCustomKey({ id: 'k', text: 'git status' })!
    expect(customKeyLabel(def)).toBe('git status')
    expect(customKeyLabel({ ...def, name: 'Git' })).toBe('Git')
    expect(customKeyDetail(def)).toBe('git status ↵')
    expect(customKeyInput(def)).toEqual({ data: 'git status', enter: '\r' })
    expect(customKeyInput({ ...def, enter: false })).toEqual({ data: 'git status', enter: '' })
  })

  it('adds, edits and removes keys', () => {
    let layout = saveCustomKey(defaultShortcutLayout(), custom('a'))
    expect(layout.order.at(-1)).toBe('custom:a')
    layout = saveCustomKey(layout, custom('a', { text: '/clear' }))
    expect(layout.custom).toHaveLength(1)
    expect(layout.custom[0].text).toBe('/clear')
    layout = toggleShortcutKeyHidden(layout, 'custom:a')
    layout = removeCustomKey(layout, 'a')
    expect(layout.custom).toEqual([])
    expect(layout.order).not.toContain('custom:a')
    expect(layout.hidden).not.toContain('custom:a')
  })

  it('enforces the custom key limit', () => {
    let layout = defaultShortcutLayout()
    for (let index = 0; index < CUSTOM_KEY_LIMIT + 2; index++) layout = saveCustomKey(layout, custom(`k${index}`))
    expect(layout.custom).toHaveLength(CUSTOM_KEY_LIMIT)
  })

  it('creates unique ids', () => {
    const layout = saveCustomKey(defaultShortcutLayout(), custom('k0'))
    const values = [0, 0, 0.5]
    expect(newCustomKeyId(layout, () => values.shift() ?? 0.5)).not.toBe('k0')
  })

  it('finds custom keys by shortcut and detects conflicts', () => {
    const layout = saveCustomKey(defaultShortcutLayout(), custom('a', { shortcut: 'Ctrl+Alt+1' }))
    expect(customKeyForShortcut(layout, 'Alt+Ctrl+1')?.id).toBe('a')
    expect(customKeyForShortcut(layout, 'Ctrl+Alt+2')).toBeNull()
    expect(customKeyForShortcut(layout, null)).toBeNull()
    expect(customShortcutConflict(layout, 'b', 'Ctrl+Alt+1')).toMatchObject({ kind: 'custom' })
    expect(customShortcutConflict(layout, 'a', 'Ctrl+Alt+1')).toBeNull()
    expect(customShortcutConflict(layout, 'b', 'Ctrl+V')).toEqual({ kind: 'terminal' })
  })
})

describe('layout editing', () => {
  it('moves keys within bounds', () => {
    const layout = defaultShortcutLayout()
    expect(moveShortcutKey(layout, 'esc', -1)).toBe(layout)
    expect(moveShortcutKey(layout, 'esc', 1).order.slice(0, 2)).toEqual(['interrupt', 'esc'])
  })

  it('toggles visibility and detects default layout', () => {
    const layout = defaultShortcutLayout()
    expect(isDefaultShortcutLayout(layout)).toBe(true)
    const shown = toggleShortcutKeyHidden(layout, 'up')
    expect(shown.hidden).not.toContain('up')
    expect(isDefaultShortcutLayout(shown)).toBe(false)
    expect(toggleShortcutKeyHidden(layout, 'nope')).toBe(layout)
    // 自定义键不影响「是否为默认」。
    expect(isDefaultShortcutLayout(saveCustomKey(layout, custom('a')))).toBe(true)
  })
})

describe('fitShortcutKeyCount', () => {
  it('fits keys in order until the width runs out', () => {
    expect(fitShortcutKeyCount([30, 30, 30], 100, 4)).toBe(3)
    expect(fitShortcutKeyCount([30, 30, 30], 90, 4)).toBe(2)
    expect(fitShortcutKeyCount([30], 10, 4)).toBe(0)
    expect(fitShortcutKeyCount([], 10, 4)).toBe(0)
  })
})

describe('builtinKeySequence', () => {
  it('maps keys to PTY sequences', () => {
    expect(builtinKeySequence('esc')).toBe('\x1b')
    expect(builtinKeySequence('interrupt')).toBe('\x03')
    expect(builtinKeySequence('shift-tab')).toBe('\x1b[Z')
    expect(builtinKeySequence('tab')).toBe('\t')
    expect(builtinKeySequence('backspace')).toBe('\x7f')
    expect(builtinKeySequence('pgup')).toBe('\x1b[5~')
    expect(builtinKeySequence('up')).toBe('\x1b[A')
    expect(builtinKeySequence('up', { applicationCursor: true })).toBe('\x1bOA')
    expect(builtinKeySequence('end')).toBe('\x1b[F')
    expect(builtinKeySequence('clear-input')).toBeNull()
  })
})
