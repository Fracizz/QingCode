import { beforeEach, describe, expect, it } from 'vitest'
import {
  editorSurface,
  isProjectWelcomePending,
  noteProjectEditorOpened,
  recentFileParentLabel,
  resetEditorWelcomeSession,
} from './editorSurface'

const visible = {
  editorVisible: true,
  projectWelcome: true,
}

describe('editorSurface', () => {
  it('shows the editor whenever a file tab is active', () => {
    expect(
      editorSurface({
        activeTabId: 'tab-1',
        hasProject: true,
        projectsReady: true,
        editorVisible: false,
        projectWelcome: false,
      })
    ).toBe('editor')
    expect(
      editorSurface({
        activeTabId: 'tab-1',
        hasProject: false,
        projectsReady: false,
        ...visible,
      })
    ).toBe('editor')
  })

  it('shows the welcome when no project is open and the editor column is visible', () => {
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: false,
        projectsReady: true,
        editorVisible: true,
        projectWelcome: false,
      })
    ).toBe('welcome')
  })

  it('shows the welcome the first time a project is open and no file is open', () => {
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: true,
        projectsReady: true,
        editorVisible: true,
        projectWelcome: true,
      })
    ).toBe('welcome')
  })

  it('shows the project idle view once the project has already opened a file', () => {
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: true,
        projectsReady: true,
        editorVisible: true,
        projectWelcome: false,
      })
    ).toBe('projectIdle')
  })

  it('hides the project idle view when the editor column is hidden', () => {
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: true,
        projectsReady: true,
        editorVisible: false,
        projectWelcome: false,
      })
    ).toBe('blank')
  })

  it('hides the welcome when the editor column is hidden', () => {
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: false,
        projectsReady: true,
        editorVisible: false,
        projectWelcome: true,
      })
    ).toBe('blank')
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: true,
        projectsReady: true,
        editorVisible: false,
        projectWelcome: true,
      })
    ).toBe('blank')
  })

  it('stays blank while projects are still loading', () => {
    expect(
      editorSurface({
        activeTabId: null,
        hasProject: false,
        projectsReady: false,
        ...visible,
      })
    ).toBe('blank')
  })
})

describe('project welcome session', () => {
  beforeEach(() => {
    resetEditorWelcomeSession()
  })

  it('keeps the welcome pending until the project opens a file', () => {
    expect(isProjectWelcomePending('proj-1')).toBe(true)
    expect(isProjectWelcomePending(null)).toBe(false)
    noteProjectEditorOpened('proj-1')
    expect(isProjectWelcomePending('proj-1')).toBe(false)
    expect(isProjectWelcomePending('proj-2')).toBe(true)
  })
})

describe('recentFileParentLabel', () => {
  it('returns the parent relative to a Windows project root', () => {
    expect(recentFileParentLabel('D:\\code\\qingcode', 'D:\\code\\qingcode\\src\\lib\\a.ts')).toBe('src/lib')
    expect(recentFileParentLabel('d:\\code\\qingcode\\', 'D:\\code\\qingcode\\src\\a.ts')).toBe('src')
  })

  it('returns an empty label for files at the project root', () => {
    expect(recentFileParentLabel('D:\\code\\qingcode', 'D:\\code\\qingcode\\DESIGN.md')).toBe('')
  })

  it('handles ssh resource paths', () => {
    expect(recentFileParentLabel('ssh://c1/home/u/app', 'ssh://c1/home/u/app/src/main.py')).toBe('src')
  })

  it('does not treat a sibling folder sharing a prefix as inside the project', () => {
    expect(recentFileParentLabel('D:\\code\\app', 'D:\\code\\app2\\x.ts')).toBe('D:/code/app2')
  })
})
