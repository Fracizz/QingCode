import { describe, expect, it } from 'vitest'
import {
  canonicalizeShortcut,
  isReservedShortcut,
  shortcutFromKeyboardEvent,
  shortcutMatchesEvent,
} from './shortcuts'

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 'F',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...init,
  } as KeyboardEvent
}

describe('canonicalizeShortcut', () => {
  it('treats Shift+Alt+F and Alt+Shift+F as the same binding', () => {
    expect(canonicalizeShortcut('Shift+Alt+F')).toBe('Alt+Shift+F')
    expect(canonicalizeShortcut('Alt+Shift+F')).toBe('Alt+Shift+F')
  })
})

describe('shortcutMatchesEvent', () => {
  it('matches format-document when modifiers are pressed in either UI order', () => {
    const event = keyEvent({ key: 'f', altKey: true, shiftKey: true })
    expect(shortcutFromKeyboardEvent(event)).toBe('Alt+Shift+F')
    expect(shortcutMatchesEvent('Shift+Alt+F', event)).toBe(true)
    expect(shortcutMatchesEvent('Alt+Shift+F', event)).toBe(true)
  })

  it('does not match unbound (empty) shortcuts', () => {
    const event = keyEvent({ key: 'F2' })
    expect(shortcutMatchesEvent('', event)).toBe(false)
    expect(shortcutMatchesEvent('   ', event)).toBe(false)
  })

  it('matches bare function keys', () => {
    const event = keyEvent({ key: 'F2' })
    expect(shortcutFromKeyboardEvent(event)).toBe('F2')
    expect(shortcutMatchesEvent('F2', event)).toBe(true)
  })

  it('matches copy-path and copy-file-reference reserved bindings', () => {
    const copyPath = keyEvent({ key: 'c', ctrlKey: true, shiftKey: true })
    expect(shortcutMatchesEvent('Ctrl+Shift+C', copyPath)).toBe(true)

    const copyRef = keyEvent({ key: 'c', altKey: true })
    expect(shortcutFromKeyboardEvent(copyRef)).toBe('Alt+C')
    expect(shortcutMatchesEvent('Alt+C', copyRef)).toBe(true)
  })
})

describe('isReservedShortcut', () => {
  it('recognizes format shortcut regardless of modifier spelling order', () => {
    expect(isReservedShortcut('Shift+Alt+F')).toBe(true)
    expect(isReservedShortcut('Alt+Shift+F')).toBe(true)
  })

  it('recognizes copy-path and copy-file-reference shortcuts', () => {
    expect(isReservedShortcut('Ctrl+Shift+C')).toBe(true)
    expect(isReservedShortcut('Alt+C')).toBe(true)
  })
})
