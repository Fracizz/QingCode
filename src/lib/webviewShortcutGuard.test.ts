import { describe, expect, it, vi } from 'vitest'
import {
  isWebviewNativeShortcut,
  preventWebviewNativeShortcut,
} from './webviewShortcutGuard'

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

const prodGuard = { allowDevtools: false } as const
const devGuard = { allowDevtools: true } as const

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
  ])('blocks WebView shortcut $key in production', shortcut => {
    expect(isWebviewNativeShortcut(keyEvent(shortcut), prodGuard)).toBe(true)
  })

  it.each([
    { key: 'F12' },
    { key: 'i', ctrlKey: true, shiftKey: true },
    { key: 'j', ctrlKey: true, shiftKey: true },
    { key: 'c', ctrlKey: true, shiftKey: true },
    { key: 'i', metaKey: true, altKey: true },
    { key: 'j', metaKey: true, altKey: true },
    { key: 'c', metaKey: true, altKey: true },
  ])('allows devtools shortcut $key in dev builds', shortcut => {
    expect(isWebviewNativeShortcut(keyEvent(shortcut), devGuard)).toBe(false)
  })

  it.each([{ key: 'F5' }, { key: 'r', ctrlKey: true }])(
    'still blocks refresh shortcut $key in dev builds',
    shortcut => {
      expect(isWebviewNativeShortcut(keyEvent(shortcut), devGuard)).toBe(true)
    },
  )

  it.each([
    { key: 'p', ctrlKey: true },
    { key: 's', ctrlKey: true },
    { key: 'f', altKey: true, shiftKey: true },
    { key: 'F2' },
    { key: 'c', ctrlKey: true, shiftKey: true, altKey: true },
  ])('keeps QingCode shortcut $key available', shortcut => {
    expect(isWebviewNativeShortcut(keyEvent(shortcut), prodGuard)).toBe(false)
  })

  it('cancels the WebView default without stopping QingCode event propagation', () => {
    const event = keyEvent({ key: 'c', ctrlKey: true, shiftKey: true })

    expect(preventWebviewNativeShortcut(event, prodGuard)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })
})
