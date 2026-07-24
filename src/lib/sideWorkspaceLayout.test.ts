import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SIDE_WORKSPACE,
  loadSideWorkspaceColumns,
  parseSideWorkspaceColumns,
  saveSideWorkspaceColumns,
  SIDE_EDITOR_COLLAPSED_KEY,
  SIDE_WORKSPACE_KEY,
} from './sideWorkspaceLayout'

const memory = new Map<string, string>()

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
  })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseSideWorkspaceColumns', () => {
  it('defaults and coerces booleans', () => {
    expect(parseSideWorkspaceColumns(null)).toEqual(DEFAULT_SIDE_WORKSPACE)
    expect(parseSideWorkspaceColumns({ dualTerminal: true, editorVisible: true })).toEqual({
      dualTerminal: true,
      editorVisible: true,
    })
  })
})

describe('load/saveSideWorkspaceColumns', () => {
  it('defaults to dual terminal without editor', () => {
    expect(loadSideWorkspaceColumns()).toEqual({
      dualTerminal: true,
      editorVisible: false,
    })
  })

  it('migrates legacy side-editor-collapsed', () => {
    memory.set(SIDE_EDITOR_COLLAPSED_KEY, '1')
    expect(loadSideWorkspaceColumns()).toEqual({
      dualTerminal: true,
      editorVisible: false,
    })
    memory.clear()
    memory.set(SIDE_EDITOR_COLLAPSED_KEY, '0')
    expect(loadSideWorkspaceColumns()).toEqual({
      dualTerminal: false,
      editorVisible: true,
    })
  })

  it('persists the new workspace key', () => {
    saveSideWorkspaceColumns({ dualTerminal: true, editorVisible: true })
    expect(JSON.parse(memory.get(SIDE_WORKSPACE_KEY) ?? '{}')).toEqual({
      dualTerminal: true,
      editorVisible: true,
    })
    expect(memory.get(SIDE_EDITOR_COLLAPSED_KEY)).toBe('0')
    expect(loadSideWorkspaceColumns()).toEqual({
      dualTerminal: true,
      editorVisible: true,
    })
  })
})
