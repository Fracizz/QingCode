import { describe, expect, it } from 'vitest'
import {
  SHORTCUT_KEYS,
  defaultKeyLayout,
  dragTargetIndex,
  isDefaultKeyLayout,
  moveKey,
  moveKeyTo,
  parseKeyLayout,
  serializeKeyLayout,
  toggleKeyHidden,
  visibleKeys,
} from '../../mobile/android/web/keyLayout.js'

const defaults = SHORTCUT_KEYS.map(item => item.key)

describe('Android shortcut bar layout', () => {
  it('starts with the frequency-ordered defaults and nothing hidden', () => {
    expect(defaults.slice(0, 3)).toEqual(['esc', 'tab', 'interrupt'])
    expect(defaultKeyLayout()).toEqual({ order: defaults, hidden: [] })
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

  it('hidden keys leave the bar but stay reachable in More, in order', () => {
    let layout = toggleKeyHidden(defaultKeyLayout(), 'left')
    layout = toggleKeyHidden(layout, 'shift-tab')
    const { bar, overflow } = visibleKeys(layout)
    expect(bar).not.toContain('left')
    expect(overflow).toEqual(['shift-tab', 'left'])
    expect(bar.length + overflow.length).toBe(defaults.length)
    expect(visibleKeys(toggleKeyHidden(layout, 'left')).bar).toContain('left')
  })
})
