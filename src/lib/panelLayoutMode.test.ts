import { describe, expect, it } from 'vitest'
import {
  nextPanelLayoutMode,
  normalizePanelLayoutMode,
  panelLayoutModeLabel,
  panelLayoutModeParts,
  resolvePanelLayoutMode,
} from './panelLayoutMode'

describe('resolvePanelLayoutMode', () => {
  it('maps classic / side / dual+editor; editor-hidden / 田 are not presets', () => {
    expect(
      resolvePanelLayoutMode('classic', {
        dualTerminal: true,
        quadTerminal: false,
        editorVisible: false,
      }),
    ).toBe('classic')
    expect(
      resolvePanelLayoutMode('sideTerminal', {
        dualTerminal: false,
        quadTerminal: false,
        editorVisible: true,
      }),
    ).toBe('sideTerminal')
    expect(
      resolvePanelLayoutMode('sideTerminal', {
        dualTerminal: true,
        quadTerminal: false,
        editorVisible: false,
      }),
    ).toBeNull()
    expect(
      resolvePanelLayoutMode('sideTerminal', {
        dualTerminal: false,
        quadTerminal: false,
        editorVisible: false,
      }),
    ).toBeNull()
    expect(
      resolvePanelLayoutMode('sideTerminal', {
        dualTerminal: true,
        quadTerminal: false,
        editorVisible: true,
      }),
    ).toBe('sideDualEditor')
    expect(
      resolvePanelLayoutMode('sideTerminal', {
        dualTerminal: false,
        quadTerminal: true,
        editorVisible: true,
      }),
    ).toBeNull()
  })
})

describe('panelLayoutModeParts', () => {
  it('expands each mode into dock + column flags', () => {
    expect(panelLayoutModeParts('classic')).toEqual({
      panelLayout: 'classic',
      columns: null,
    })
    expect(panelLayoutModeParts('sideTerminal')).toEqual({
      panelLayout: 'sideTerminal',
      columns: { dualTerminal: false, quadTerminal: false, editorVisible: true },
    })
    expect(panelLayoutModeParts('sideDualEditor')).toEqual({
      panelLayout: 'sideTerminal',
      columns: { dualTerminal: true, quadTerminal: false, editorVisible: true },
    })
  })

  it('maps legacy dual-only aliases to dual+editor', () => {
    expect(panelLayoutModeParts('sideDual')).toEqual({
      panelLayout: 'sideTerminal',
      columns: { dualTerminal: true, quadTerminal: false, editorVisible: true },
    })
  })
})

describe('nextPanelLayoutMode', () => {
  it('cycles classic → side → dual+editor', () => {
    expect(nextPanelLayoutMode('classic')).toBe('sideTerminal')
    expect(nextPanelLayoutMode('sideTerminal')).toBe('sideDualEditor')
    expect(nextPanelLayoutMode('sideDualEditor')).toBe('classic')
  })

  it('treats fine-tuned null as before classic in the cycle', () => {
    expect(nextPanelLayoutMode(null)).toBe('classic')
  })
})

describe('panelLayoutModeLabel', () => {
  it('returns Chinese source labels for i18n', () => {
    expect(panelLayoutModeLabel('classic')).toBe('经典布局（终端在底部）')
    expect(panelLayoutModeLabel('sideTerminal')).toBe('终端+编辑器')
    expect(panelLayoutModeLabel('sideDualEditor')).toBe('双终端+编辑器')
  })
})

describe('normalizePanelLayoutMode', () => {
  it('maps legacy dual-only aliases to dual+editor', () => {
    expect(normalizePanelLayoutMode('sideTerminalCollapsed')).toBe('sideDualEditor')
    expect(normalizePanelLayoutMode('sideDual')).toBe('sideDualEditor')
  })
})
