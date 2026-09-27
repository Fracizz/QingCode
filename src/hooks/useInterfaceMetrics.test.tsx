// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFontSettings, DEFAULT_FONT_SETTINGS, FONT_SETTINGS_EVENT, saveFontSettings } from '../lib/fontSettings'
import { readTooltipZoom } from '../components/Tooltip'
import { useInterfaceMetrics } from './useInterfaceMetrics'

afterEach(() => {
  document.documentElement.removeAttribute('style')
  localStorage.clear()
})

describe('live interface typography', () => {
  it('updates virtual row metrics once while keeping editor and terminal fonts independent', () => {
    applyFontSettings(DEFAULT_FONT_SETTINGS)
    const { result } = renderHook(useInterfaceMetrics)
    const onChange = vi.fn()
    window.addEventListener(FONT_SETTINGS_EVENT, onChange)
    try {
      act(() => saveFontSettings({ ...DEFAULT_FONT_SETTINGS, interfaceFontSize: 16 },
        { syncEditorFontSizeToSettings: false }))
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(result.current).toMatchObject({ fontSize: 16, rowHeight: 32, chipHeight: 30, titleHeight: 39 })
      const style = document.documentElement.style
      expect(style.getPropertyValue('--ui-font-size')).toBe('16px')
      expect(style.getPropertyValue('--ui-font-size-sm')).toBe('15px')
      expect(style.getPropertyValue('--editor-font-size')).toBe('14px')
      expect(style.getPropertyValue('--terminal-font-size')).toBe('13px')
      expect(style.getPropertyValue('--ui-font-scale')).toBe('')
    } finally {
      window.removeEventListener(FONT_SETTINGS_EVENT, onChange)
    }
  })

  it('never treats a font preference or legacy scale token as menu geometry', () => {
    document.documentElement.style.setProperty('--ui-font-scale', '1.5')
    expect(readTooltipZoom()).toBe(1)
    applyFontSettings({ ...DEFAULT_FONT_SETTINGS, interfaceFontSize: 20 })
    expect(readTooltipZoom()).toBe(1)
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('')
  })
})
