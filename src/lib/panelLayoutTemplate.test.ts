import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cyclePanelLayoutTemplate,
  DEFAULT_PANEL_LAYOUT,
  loadPanelLayoutTemplate,
  nextPanelLayoutTemplate,
  PANEL_LAYOUT_KEY,
  parsePanelLayoutTemplate,
  savePanelLayoutTemplate,
  terminalPositionForTemplate,
} from './panelLayoutTemplate'

const memory = new Map<string, string>()

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
    removeItem: (key: string) => {
      memory.delete(key)
    },
  })
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parsePanelLayoutTemplate', () => {
  it('accepts known templates and defaults otherwise', () => {
    expect(parsePanelLayoutTemplate('classic')).toBe('classic')
    expect(parsePanelLayoutTemplate('sideTerminal')).toBe('sideTerminal')
    expect(parsePanelLayoutTemplate('other')).toBe(DEFAULT_PANEL_LAYOUT)
    expect(parsePanelLayoutTemplate(null)).toBe(DEFAULT_PANEL_LAYOUT)
  })
})

describe('nextPanelLayoutTemplate', () => {
  it('cycles classic ↔ sideTerminal', () => {
    expect(nextPanelLayoutTemplate('classic')).toBe('sideTerminal')
    expect(nextPanelLayoutTemplate('sideTerminal')).toBe('classic')
  })
})

describe('terminalPositionForTemplate', () => {
  it('maps templates to dock positions', () => {
    expect(terminalPositionForTemplate('classic')).toBe('bottom')
    expect(terminalPositionForTemplate('sideTerminal')).toBe('side')
  })
})

describe('load/save/cycle', () => {
  it('persists and cycles through localStorage', () => {
    expect(loadPanelLayoutTemplate()).toBe('classic')
    savePanelLayoutTemplate('sideTerminal')
    expect(loadPanelLayoutTemplate()).toBe('sideTerminal')
    expect(localStorage.getItem(PANEL_LAYOUT_KEY)).toBe('sideTerminal')
    expect(cyclePanelLayoutTemplate()).toBe('classic')
    expect(loadPanelLayoutTemplate()).toBe('classic')
  })
})
