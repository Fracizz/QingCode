// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FONT_SETTINGS,
  FONT_SETTINGS_EVENT,
  FONT_SETTINGS_KEY,
  JETBRAINS_MONO_FONT,
  TERMINAL_MONO_FONT,
  applyFontSettings,
  getResolvedMonoFont,
  getResolvedTerminalFont,
  loadFontSettings,
  saveFontSettings,
  systemFontOptions,
} from './fontSettings'

beforeEach(() => {
  localStorage.clear()
  applyFontSettings(DEFAULT_FONT_SETTINGS)
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  applyFontSettings(DEFAULT_FONT_SETTINGS)
})

describe('independent terminal font', () => {
  it('only offers installed monospace families for the terminal', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: (text: string) => ({ width: text === 'MW' ? 24 : 8 }),
    } as unknown as CanvasRenderingContext2D)
    const families = ['Consolas', 'Arial', 'JetBrains Mono']
    expect(systemFontOptions(families, 'terminal').map(option => option.label))
      .toEqual(['Consolas', 'JetBrains Mono'])
    expect(systemFontOptions(families, 'sans')).toHaveLength(3)
  })

  it('migrates older preferences to an independent terminal default and keeps legacy sizes', () => {
    localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify({
      monoFont: JETBRAINS_MONO_FONT, monoFontSize: 16,
    }))
    const settings = loadFontSettings()
    expect(settings).toMatchObject({ terminalFont: TERMINAL_MONO_FONT, editorFontSize: 16, terminalFontSize: 16 })
    applyFontSettings(settings)
    expect(getResolvedTerminalFont()).toMatch(/^"Cascadia Mono",/)
  })

  it('persists a terminal font, applies it immediately, and preserves the editor font', () => {
    const changed = vi.fn()
    window.addEventListener(FONT_SETTINGS_EVENT, changed)
    try {
      saveFontSettings({
        ...DEFAULT_FONT_SETTINGS, terminalFont: JETBRAINS_MONO_FONT,
      }, { syncEditorFontSizeToSettings: false })
      expect(changed).toHaveBeenCalledOnce()
      expect(getResolvedTerminalFont()).toMatch(/^"JetBrains Mono",/)
      expect(getResolvedMonoFont()).toBe(DEFAULT_FONT_SETTINGS.monoFont)
      expect(loadFontSettings().terminalFont).toBe(JETBRAINS_MONO_FONT)
      applyFontSettings(loadFontSettings())
      expect(getResolvedTerminalFont()).toMatch(/^"JetBrains Mono",/)
    } finally {
      window.removeEventListener(FONT_SETTINGS_EVENT, changed)
    }
  })

  it('keeps both explicit and default terminal fonts independent of editor changes', () => {
    applyFontSettings({
      ...DEFAULT_FONT_SETTINGS, monoFont: '"Fira Code", monospace',
      terminalFont: JETBRAINS_MONO_FONT,
    })
    expect(getResolvedTerminalFont()).toMatch(/^"JetBrains Mono",/)
    applyFontSettings({ ...DEFAULT_FONT_SETTINGS, monoFont: '"Fira Code", monospace' })
    expect(getResolvedTerminalFont()).toMatch(/^"Cascadia Mono",/)
    document.documentElement.style.removeProperty('--terminal-font-family')
    expect(getResolvedTerminalFont()).toMatch(/^"Cascadia Mono",/)
  })

  it.each(['', '  '])('normalizes empty legacy terminal fonts (%j) on load and save', terminalFont => {
    const settings = { ...DEFAULT_FONT_SETTINGS, monoFont: JETBRAINS_MONO_FONT, terminalFont }
    localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify(settings))
    expect(loadFontSettings().terminalFont).toBe(TERMINAL_MONO_FONT)
    saveFontSettings(settings, { syncEditorFontSizeToSettings: false })
    expect(JSON.parse(localStorage.getItem(FONT_SETTINGS_KEY)!)).toMatchObject({
      terminalFont: TERMINAL_MONO_FONT,
    })
    expect(getResolvedTerminalFont()).toMatch(/^"Cascadia Mono",/)
  })

  it('rejects proportional fonts while retaining safe terminal fallbacks', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: (text: string) => ({ width: text === 'MW' ? 24 : 8 }),
    } as unknown as CanvasRenderingContext2D)
    applyFontSettings({ ...DEFAULT_FONT_SETTINGS, terminalFont: 'Arial, ui-monospace' })
    expect(getResolvedTerminalFont()).not.toMatch(/Arial|ui-monospace/)
    expect(getResolvedTerminalFont()).toContain('Consolas')
  })
})
