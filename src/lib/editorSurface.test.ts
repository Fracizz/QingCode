import { describe, expect, it } from 'vitest'
import { editorSurface } from './editorSurface'

describe('editorSurface', () => {
  it('shows the editor whenever a file tab is active', () => {
    expect(editorSurface({ activeTabId: 'tab-1', hasProject: true, projectsReady: true })).toBe(
      'editor',
    )
    expect(editorSurface({ activeTabId: 'tab-1', hasProject: false, projectsReady: false })).toBe(
      'editor',
    )
  })

  it('shows the welcome only after startup when no project is open', () => {
    expect(editorSurface({ activeTabId: null, hasProject: false, projectsReady: true })).toBe(
      'welcome',
    )
  })

  it('stays blank while projects are still loading', () => {
    expect(editorSurface({ activeTabId: null, hasProject: false, projectsReady: false })).toBe(
      'blank',
    )
  })

  it('stays blank when a project is open but no file tab is active', () => {
    expect(editorSurface({ activeTabId: null, hasProject: true, projectsReady: true })).toBe(
      'blank',
    )
  })
})
