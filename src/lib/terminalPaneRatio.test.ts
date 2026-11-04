import { describe, expect, it } from 'vitest'
import { parseTerminalPaneRatio } from './terminalPaneRatio'

describe('terminal pane ratio preferences', () => {
  it('opens equally sized panes for missing, empty or invalid preferences', () => {
    for (const value of [null, '', ' ', 'broken', 'Infinity']) {
      expect(parseTerminalPaneRatio(value)).toBe(0.5)
    }
  })
  it('preserves saved proportions within the supported bounds', () => {
    expect(parseTerminalPaneRatio('0.67')).toBe(0.67)
    expect(parseTerminalPaneRatio('0')).toBe(0.1)
    expect(parseTerminalPaneRatio('1')).toBe(0.9)
  })
})
