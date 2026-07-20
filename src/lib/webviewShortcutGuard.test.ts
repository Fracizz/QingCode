import { describe, expect, it, vi } from 'vitest'
import { isWebviewNativeShortcut } from './webviewShortcutGuard'

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...init,
  } as unknown as KeyboardEvent
}

describe('isWebviewNativeShortcut', () => {
  it.each([
    { key: 'F5' },
    { key: 'r', ctrlKey: true },
    { key: 'R', ctrlKey: true, shiftKey: true },
    { key: 'r', metaKey: true },
    { key: 'F12' },
    { key: 'i', ctrlKey: true, shiftKey: true },
    { key: 'j', ctrlKey: true, shiftKey: true },
    { key: 'c', ctrlKey: true, shiftKey: true },
    { key: 'i', metaKey: true, altKey: true },
    { key: 'j', metaKey: true, altKey: true },
    { key: 'c', metaKey: true, altKey: true },
  ])('blocks WebView shortcut $key', shortcut => {
    expect(isWebviewNativeShortcut(keyEvent(shortcut))).toBe(true)
  })

  it.each([
    { key: 'p', ctrlKey: true },
    { key: 's', ctrlKey: true },
    { key: 'f', altKey: true, shiftKey: true },
    { key: 'F2' },
    { key: 'c', ctrlKey: true, shiftKey: true, altKey: true },
  ])('keeps QingCode shortcut $key available', shortcut => {
    expect(isWebviewNativeShortcut(keyEvent(shortcut))).toBe(false)
  })
})
