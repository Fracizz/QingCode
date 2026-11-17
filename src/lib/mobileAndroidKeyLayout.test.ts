import { describe, expect, it } from 'vitest'
import {
  CUSTOM_KEY_LIMIT,
  SHORTCUT_KEYS,
  customKeyDetail,
  customKeyInput,
  customKeyLabel,
  defaultKeyLayout,
  findCustomKey,
  newCustomKeyId,
  normalizeCustomKey,
  removeCustomKey,
  saveCustomKey,
  dragProbe,
  dragTargetIndex,
  isDefaultKeyLayout,
  moveKey,
  moveKeyTo,
  parseKeyLayout,
  serializeKeyLayout,
  toggleKeyHidden,
  visibleKeys,
} from '../../mobile/android/web/keyLayout.js'

const builtins = SHORTCUT_KEYS.map(item => item.key)
const defaults = builtins

describe('Android shortcut bar layout', () => {
  it('starts with the frequency-ordered defaults and nothing hidden', () => {
    expect(defaults.slice(0, 3)).toEqual(['esc', 'tab', 'interrupt'])
    expect(defaultKeyLayout()).toEqual({ order: defaults, hidden: [], custom: [] })
    expect(isDefaultKeyLayout(defaultKeyLayout())).toBe(true)
  })

  it.each([null, '', '{', '[]', '{"order":"esc"}', 42])('falls back to defaults for damaged value %j', raw => {
    expect(parseKeyLayout(raw)).toEqual(defaultKeyLayout())
  })

  it('round-trips a saved layout', () => {
    const layout = toggleKeyHidden(moveKey(defaultKeyLayout(), 'slash', -1), 'shift-tab')
    expect(parseKeyLayout(serializeKeyLayout(layout))).toEqual(layout)
    expect(isDefaultKeyLayout(layout)).toBe(false)
  })

  it('drops unknown and duplicate keys and restores keys added by a newer version', () => {
    const parsed = parseKeyLayout(JSON.stringify({
      order: ['interrupt', 'esc', 'esc', 'bogus', 'up'],
      hidden: ['bogus', 'up', 'up'],
    }))
    expect(parsed.hidden).toEqual(['up'])
    expect(new Set(parsed.order)).toEqual(new Set(defaults))
    expect(parsed.order).toHaveLength(defaults.length)
    // 用户自定的相对顺序保留：interrupt 在 esc 之前。
    expect(parsed.order.indexOf('interrupt')).toBeLessThan(parsed.order.indexOf('esc'))
    // 缺失的 tab 补到默认顺序里前一个键 esc 之后。
    expect(parsed.order[parsed.order.indexOf('esc') + 1]).toBe('tab')
  })

  it('moves keys one step and ignores moves past either end', () => {
    const layout = defaultKeyLayout()
    expect(moveKey(layout, 'tab', -1).order.slice(0, 2)).toEqual(['tab', 'esc'])
    expect(moveKey(layout, 'esc', -1)).toBe(layout)
    expect(moveKey(layout, 'right', 1)).toBe(layout)
    expect(moveKey(layout, 'bogus', 1)).toBe(layout)
    expect(layout.order).toEqual(defaults)
  })

  it('drags a key to any position, clamping out-of-range targets', () => {
    const layout = defaultKeyLayout()
    expect(moveKeyTo(layout, 'right', 0).order.slice(0, 2)).toEqual(['right', 'esc'])
    expect(moveKeyTo(layout, 'esc', 3).order.slice(0, 4)).toEqual(['tab', 'interrupt', 'shift-tab', 'esc'])
    expect(moveKeyTo(layout, 'esc', 99).order.at(-1)).toBe('esc')
    expect(moveKeyTo(layout, 'tab', 1)).toBe(layout)
    expect(moveKeyTo(layout, 'bogus', 0)).toBe(layout)
    expect(layout.order).toEqual(defaults)
  })

  it('picks the drop slot only after crossing a neighbour midline', () => {
    const mids = [25, 75, 125, 175]
    expect(dragTargetIndex(mids, 1, 75)).toBe(1)
    expect(dragTargetIndex(mids, 1, 124)).toBe(1)
    expect(dragTargetIndex(mids, 1, 126)).toBe(2)
    expect(dragTargetIndex(mids, 1, 400)).toBe(3)
    expect(dragTargetIndex(mids, 2, 24)).toBe(0)
    expect(dragTargetIndex(mids, 2, 76)).toBe(2)
  })

  it('dragging to the list edge reaches the first and last slot', () => {
    // 四行各高 50，列表 0~200；被拖行夹在列表内，拖到顶时中心 25 恰好等于首行中线。
    const mids = [25, 75, 125, 175]
    expect(dragTargetIndex(mids, 2, mids[2] - 100)).toBe(1)
    expect(dragTargetIndex(mids, 2, dragProbe(mids[2], -100, 25))).toBe(0)
    expect(dragTargetIndex(mids, 1, dragProbe(mids[1], 100, 25))).toBe(3)
    // 越过邻行一半才让位，未移动时停在原位。
    expect(dragTargetIndex(mids, 2, dragProbe(mids[2], -24, 25))).toBe(2)
    expect(dragTargetIndex(mids, 2, dragProbe(mids[2], -26, 25))).toBe(1)
    expect(dragProbe(125, 0, 25)).toBe(125)
  })

  it('hidden keys leave the bar but stay reachable in More, in order', () => {
    let layout = toggleKeyHidden(defaultKeyLayout(), 'left')
    layout = toggleKeyHidden(layout, 'shift-tab')
    const { bar, overflow } = visibleKeys(layout)
    expect(bar).not.toContain('left')
    expect(overflow).toEqual(['shift-tab', 'left'])
    expect(bar.length + overflow.length).toBe(defaults.length)
    expect(visibleKeys(toggleKeyHidden(layout, 'left')).bar).toContain('left')
  })

  it('has no custom keys by default, including layouts saved before custom keys existed', () => {
    const old = parseKeyLayout(JSON.stringify({ order: [...builtins].reverse(), hidden: ['esc'] }))
    expect(old.custom).toEqual([])
    expect(old.order).toEqual([...builtins].reverse())
  })

  it('validates custom keys: trims text and rejects empty, multi-line or control text', () => {
    expect(normalizeCustomKey({ id: 'a', name: '  新会话 ', text: ' /new ', enter: true }))
      .toEqual({ id: 'a', name: '新会话', text: '/new', enter: true })
    expect(normalizeCustomKey({ id: 'a', text: 'git status', enter: false })?.enter).toBe(false)
    for (const text of ['', '   ', 'a\nb', 'a\rb', '\x1b[A', 'x'.repeat(201)]) {
      expect(normalizeCustomKey({ id: 'a', text })).toBeNull()
    }
    expect(normalizeCustomKey({ id: 'bad id', text: '/new' })).toBeNull()
    expect(normalizeCustomKey(null)).toBeNull()
  })

  it('labels and sends custom keys: text first, Enter as a separate write', () => {
    const def = { id: 'a', name: '', text: '/new', enter: true }
    expect(customKeyLabel(def)).toBe('/new')
    expect(customKeyLabel({ ...def, name: '新会话' })).toBe('新会话')
    expect(customKeyDetail(def)).toBe('/new ↵')
    expect(customKeyInput(def)).toEqual({ data: '/new', enter: '\r' })
    expect(customKeyInput({ ...def, enter: false })).toEqual({ data: '/new', enter: '' })
  })

  it('adds, edits, hides and removes custom keys', () => {
    let layout = defaultKeyLayout()
    const id = newCustomKeyId(layout, () => 0.5)
    layout = saveCustomKey(layout, { id, name: '状态', text: 'git status', enter: true })
    expect(layout.order.at(-1)).toBe('custom:' + id)
    expect(findCustomKey(layout, 'custom:' + id)?.text).toBe('git status')
    layout = saveCustomKey(layout, { id, name: '状态', text: 'git status -sb', enter: true })
    expect(layout.custom.filter(def => def.id === id)).toHaveLength(1)
    expect(findCustomKey(layout, id)?.text).toBe('git status -sb')
    expect(saveCustomKey(layout, { id, text: '' })).toBe(layout)
    layout = toggleKeyHidden(layout, 'custom:' + id)
    expect(visibleKeys(layout).overflow).toEqual(['custom:' + id])
    expect(parseKeyLayout(serializeKeyLayout(layout))).toEqual(layout)
    layout = removeCustomKey(layout, id)
    expect(layout.order).not.toContain('custom:' + id)
    expect(layout.hidden).toEqual([])
    expect(isDefaultKeyLayout(layout)).toBe(true)
  })

  it('stops adding custom keys at the limit and drops unknown custom entries when parsing', () => {
    let layout = defaultKeyLayout()
    for (let index = 0; index < CUSTOM_KEY_LIMIT; index++) layout = saveCustomKey(layout, { id: 'k' + index, text: 'x' + index })
    expect(layout.custom).toHaveLength(CUSTOM_KEY_LIMIT)
    expect(saveCustomKey(layout, { id: 'extra', text: 'y' })).toBe(layout)
    const parsed = parseKeyLayout(JSON.stringify({ order: ['custom:ghost', 'esc'], hidden: ['custom:ghost'], custom: [{ id: 'bad', text: 'a\nb' }] }))
    expect(parsed.custom).toEqual([])
    expect(parsed.order).toEqual(builtins)
    expect(parsed.hidden).toEqual([])
  })
})
