import { describe, expect, it } from 'vitest'
import {
  CUSTOM_KEY_LIMIT,
  customKeyDetail,
  customKeyForShortcut,
  customKeyInput,
  customKeyLabel,
  customShortcutConflict,
  defaultShortcutBarState,
  defaultShortcutLayout,
  fitShortcutKeyCount,
  moveShortcutKey,
  newCustomKeyId,
  normalizeCustomKey,
  parseShortcutBarState,
  removeCustomKey,
  reorderShortcutKey,
  saveCustomKey,
  serializeShortcutBarState,
  toggleShortcutKeyHidden,
  visibleShortcutKeys,
} from './terminalShortcutBar'

const custom = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: '', text: `/${id}`, enter: true, shortcut: '', ...extra })

describe('terminalShortcutBar defaults', () => {
  it('provides no built-in keys by default', () => {
    expect(defaultShortcutLayout()).toEqual({ order: [], hidden: [], custom: [] })
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

  it('drops built-in keys saved by older versions, unknown and duplicate keys, and keeps collapsed', () => {
    const state = parseShortcutBarState({
      order: ['interrupt', 'custom:b', 'esc', 'bogus', 'custom:a', 'custom:b', 'custom:missing'],
      hidden: ['esc', 'custom:a', 'bogus'],
      removed: ['tab'],
      custom: [custom('a'), custom('b')],
      collapsed: true,
    })
    expect(state).toEqual({
      order: ['custom:b', 'custom:a'],
      hidden: ['custom:a'],
      custom: [custom('a'), custom('b')],
      collapsed: true,
    })
  })

  it('keeps valid custom keys and appends them when missing from order', () => {
    const state = parseShortcutBarState({
      order: [],
      hidden: [],
      custom: [custom('a'), custom('a'), { id: 'bad id', text: 'x' }, custom('b', { text: 'line\nbreak' })],
    })
    expect(state.custom.map(def => def.id)).toEqual(['a'])
    expect(state.order).toEqual(['custom:a'])
  })

  it('round-trips through serialize', () => {
    const state = saveCustomKey({ ...defaultShortcutBarState(), collapsed: true }, custom('x', { shortcut: 'alt+ctrl+1' }))
    expect(parseShortcutBarState(serializeShortcutBarState(state))).toEqual(state)
  })
})

describe('custom keys', () => {
  it('normalizes text, name and shortcut', () => {
    expect(normalizeCustomKey({ id: 'k1', text: '  /compact ', name: ' 压缩 ', shortcut: 'Alt+Ctrl+1' })).toEqual({
      id: 'k1', name: '压缩', text: '  /compact ', enter: true, shortcut: 'Ctrl+Alt+1',
    })
    // 结尾空格是命令的一部分（如 `git commit -m `），必须原样发送
    expect(customKeyInput(normalizeCustomKey({ id: 'k1', text: 'git commit -m ', enter: false })!).data)
      .toBe('git commit -m ')
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
  const layout = () => [custom('a'), custom('b')].reduce(saveCustomKey, defaultShortcutLayout())

  it('moves keys within bounds', () => {
    const value = layout()
    expect(moveShortcutKey(value, 'custom:a', -1)).toBe(value)
    expect(moveShortcutKey(value, 'custom:a', 1).order).toEqual(['custom:b', 'custom:a'])
  })

  it('toggles visibility and ignores unknown keys', () => {
    const value = layout()
    const hidden = toggleShortcutKeyHidden(value, 'custom:a')
    expect(visibleShortcutKeys(hidden)).toEqual({ bar: ['custom:b'], overflow: ['custom:a'] })
    expect(toggleShortcutKeyHidden(value, 'esc')).toBe(value)
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

describe('reorderShortcutKey', () => {
  const layout = () => [custom('a'), custom('b'), custom('c')].reduce(saveCustomKey, defaultShortcutLayout())

  it('moves a key before or after the target', () => {
    expect(reorderShortcutKey(layout(), 'custom:c', 'custom:a', 'before').order).toEqual(['custom:c', 'custom:a', 'custom:b'])
    expect(reorderShortcutKey(layout(), 'custom:a', 'custom:b', 'after').order).toEqual(['custom:b', 'custom:a', 'custom:c'])
  })

  it('returns the layout unchanged for same or missing keys', () => {
    const value = layout()
    expect(reorderShortcutKey(value, 'custom:a', 'custom:a', 'after')).toBe(value)
    expect(reorderShortcutKey(value, 'missing', 'custom:a', 'after')).toBe(value)
  })
})
