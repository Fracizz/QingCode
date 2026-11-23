import { describe, expect, it, vi } from 'vitest'
import { bindTerminalInBackground, clearClosedFromPanes, type PaneBindingSlice } from './panes'
import type { TerminalTab } from '../../types'

vi.mock('../uiStore', () => ({ useUIStore: { getState: () => ({ panelLayout: 'sideTerminal' }) } }))

function slice(overrides: Partial<PaneBindingSlice> = {}): PaneBindingSlice {
  return {
    activeTerminalId: null,
    secondaryTerminalId: null,
    blTerminalId: null,
    brTerminalId: null,
    activeTerminalByProject: {},
    secondaryTerminalByProject: {},
    blTerminalByProject: {},
    brTerminalByProject: {},
    ...overrides,
  }
}

describe('bindTerminalInBackground', () => {
  it('keeps the terminal already shown in the current project', () => {
    const s = slice({ activeTerminalId: 't1', activeTerminalByProject: { a: 't1' } })
    expect(bindTerminalInBackground(s, 'a', 'primary', 'mobile-1', true)).toEqual({})
  })

  it('fills an empty pane of the current project', () => {
    const next = bindTerminalInBackground(slice(), 'a', 'primary', 'mobile-1', true)
    expect(next.activeTerminalId).toBe('mobile-1')
    expect(next.activeTerminalByProject).toEqual({ a: 'mobile-1' })
  })

  it('only remembers the binding for another project without touching visible panes', () => {
    const s = slice({ activeTerminalId: 't1', activeTerminalByProject: { a: 't1' } })
    const next = bindTerminalInBackground(s, 'b', 'primary', 'mobile-1', false)
    expect(next).toEqual({ activeTerminalByProject: { a: 't1', b: 'mobile-1' } })
  })

  it('leaves another project with its own binding untouched', () => {
    const s = slice({ activeTerminalId: 't1', secondaryTerminalByProject: { b: 't2' } })
    expect(bindTerminalInBackground(s, 'b', 'secondary', 'mobile-1', false)).toEqual({})
  })
})

function term(id: string, projectId: string): TerminalTab {
  return { id, name: id, projectId, cwd: '/w', launchCommand: '', status: 'running', exitCode: null }
}

describe('clearClosedFromPanes', () => {
  it('rebinds the visible pane to the next terminal of the same project', () => {
    const s = slice({ activeTerminalId: 'gone', activeTerminalByProject: { a: 'gone' } })
    const next = clearClosedFromPanes(s, 'a', 'gone', [term('kept', 'a')])
    expect(next.activeTerminalId).toBe('kept')
    expect(next.activeTerminalByProject).toEqual({ a: 'kept' })
  })

  it('clears a background project binding to the closed terminal without touching visible panes', () => {
    const s = slice({ activeTerminalId: 't1', activeTerminalByProject: { a: 't1', b: 'gone' } })
    const next = clearClosedFromPanes(s, 'b', 'gone', [term('t1', 'a')])
    expect(next.activeTerminalId).toBe('t1')
    expect(next.activeTerminalByProject).toEqual({ a: 't1' })
  })

  it('moves a background project binding to its next terminal', () => {
    const s = slice({ activeTerminalId: 't1', activeTerminalByProject: { a: 't1', b: 'gone' } })
    const next = clearClosedFromPanes(s, 'b', 'gone', [term('t1', 'a'), term('b2', 'b')])
    expect(next.activeTerminalByProject).toEqual({ a: 't1', b: 'b2' })
  })
})
