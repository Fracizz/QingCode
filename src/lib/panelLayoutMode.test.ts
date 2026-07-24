import { describe, expect, it } from 'vitest'
import {
  nextPanelLayoutMode,
  normalizePanelLayoutMode,
  panelLayoutModeLabel,
  panelLayoutModeParts,
  resolvePanelLayoutMode,
} from './panelLayoutMode'

describe('resolvePanelLayoutMode', () => {
  it('maps classic / side / dual+editor (dual-only counts as dual+editor)', () => {
    expect(resolvePanelLayoutMode('classic', { dualTerminal: true, editorVisible: false })).toBe(
      'classic',
    )
    expect(
      resolvePanelLayoutMode('sideTerminal', { dualTerminal: false, editorVisible: true }),
    ).toBe('sideTerminal')
    expect(
      resolvePanelLayoutMode('sideTerminal', { dualTerminal: true, editorVisible: false }),
    ).toBe('sideDualEditor')
    expect(
      resolvePanelLayoutMode('sideTerminal', { dualTerminal: true, editorVisible: true }),
    ).toBe('sideDualEditor')
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
      columns: { dualTerminal: false, editorVisible: true },
    })
    expect(panelLayoutModeParts('sideDualEditor')).toEqual({
      panelLayout: 'sideTerminal',
      columns: { dualTerminal: true, editorVisible: true },
    })
  })

  it('maps legacy dual-only aliases to dual+editor', () => {
    expect(panelLayoutModeParts('sideDual')).toEqual({
      panelLayout: 'sideTerminal',
      columns: { dualTerminal: true, editorVisible: true },
    })
  })
})

describe('nextPanelLayoutMode', () => {
  it('cycles classic → side → dual+editor', () => {
    expect(nextPanelLayoutMode('classic')).toBe('sideTerminal')
    expect(nextPanelLayoutMode('sideTerminal')).toBe('sideDualEditor')
    expect(nextPanelLayoutMode('sideDualEditor')).toBe('classic')
  })
})

describe('panelLayoutModeLabel', () => {
  it('returns Chinese source labels for i18n', () => {
    expect(panelLayoutModeLabel('classic')).toBe('经典布局（终端在底部）')
    expect(panelLayoutModeLabel('sideTerminal')).toBe('侧栏旁终端')
    expect(panelLayoutModeLabel('sideDualEditor')).toBe('侧栏旁双终端 + 编辑器')
  })
})

describe('normalizePanelLayoutMode', () => {
  it('maps legacy dual-only aliases to dual+editor', () => {
    expect(normalizePanelLayoutMode('sideTerminalCollapsed')).toBe('sideDualEditor')
    expect(normalizePanelLayoutMode('sideDual')).toBe('sideDualEditor')
  })
})
