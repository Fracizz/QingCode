import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'
import {
  TERMINAL_ACTIVITY_INDICATOR_KEY,
  getTerminalActivityIndicator,
  parseTerminalActivityIndicator,
  readTerminalActivityIndicator,
  setCachedTerminalActivityIndicator,
  subscribeTerminalActivityIndicator,
} from './terminalActivitySettings'

describe('terminal activity indicator settings', () => {
  it('is on by default and only literal false disables it', () => {
    expect(readTerminalActivityIndicator(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
    expect(getTerminalActivityIndicator()).toBe(true)
    expect(parseTerminalActivityIndicator(undefined)).toBe(true)
    expect(parseTerminalActivityIndicator('false')).toBe(true)
    expect(readTerminalActivityIndicator({ [TERMINAL_ACTIVITY_INDICATOR_KEY]: false })).toBe(false)
  })

  it('notifies subscribers only on real changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalActivityIndicator(listener)
    setCachedTerminalActivityIndicator(true)
    expect(listener).not.toHaveBeenCalled()
    setCachedTerminalActivityIndicator(false)
    setCachedTerminalActivityIndicator(true)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
