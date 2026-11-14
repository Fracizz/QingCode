import { describe, expect, it } from 'vitest'
import { describeShare, followGridFor } from '../../mobile/android/web/protocol.js'

const desktop = { id: null, kind: 'desktop', name: '电脑', observe: false, typing: false, self: false }
const self = { id: 'me', kind: 'device', name: 'Pixel', observe: false, typing: false, self: true }

describe('Android multi-writer sharing', () => {
  it('follows another size owner while staying writable', () => {
    const control = { lease: 1, cols: 160, rows: 48, sizeOwner: '电脑', sizeOwnerHere: false, viewers: [desktop, self] }
    expect(followGridFor(control, null, 14)).toEqual({ cols: 160, rows: 48, owner: '电脑', initialFont: 14 })
    // 字号以进入跟随时为准，之后本机双指缩放只做本地放大。
    expect(followGridFor(control, { cols: 1, rows: 1, initialFont: 12 }, 18)?.initialFont).toBe(12)
  })

  it('does not follow when this device owns the size, is blocked, or talks to an older desktop', () => {
    expect(followGridFor({ lease: 1, cols: 40, rows: 30, sizeOwnerHere: true })).toBeNull()
    expect(followGridFor({ by: '电脑', cols: 40, rows: 30, sizeOwnerHere: false })).toBeNull()
    expect(followGridFor({ observe: true, cols: 40, rows: 30, sizeOwnerHere: false })).toBeNull()
    expect(followGridFor({ lease: 1, cols: 40, rows: 30 })).toBeNull()
  })

  it('describes the other viewers without listing this device', () => {
    const t = (text: string, params: Record<string, string> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? '')
    expect(describeShare({ viewers: [self] }, t)).toBe('')
    expect(describeShare({
      viewers: [{ ...desktop, typing: true }, self],
      sizeOwner: '电脑',
      sizeOwnerHere: false,
      sizeLocked: true,
    }, t)).toBe('电脑 也在看 · 电脑 正在输入 · 按 电脑 的尺寸显示 · 尺寸已锁定')
    expect(describeShare({
      viewers: [desktop, { id: 'tab', kind: 'device', name: 'Tab', observe: true, typing: false, self: false }, self],
      exclusiveHere: true,
    }, t)).toBe('另有 2 端在看 · 本机已独占')
  })
})
