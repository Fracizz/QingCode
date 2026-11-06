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
  it('is off by default and only literal true enables it', () => {
    expect(readTerminalActivityIndicator(DEFAULT_GLOBAL_SETTINGS)).toBe(false)
    expect(getTerminalActivityIndicator()).toBe(false)
    expect(parseTerminalActivityIndicator('true')).toBe(false)
    expect(readTerminalActivityIndicator({ [TERMINAL_ACTIVITY_INDICATOR_KEY]: true })).toBe(true)
  })

  it('notifies subscribers only on real changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalActivityIndicator(listener)
    setCachedTerminalActivityIndicator(false)
    expect(listener).not.toHaveBeenCalled()
    setCachedTerminalActivityIndicator(true)
    setCachedTerminalActivityIndicator(false)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
