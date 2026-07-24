import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SIDE_EDITOR_COLLAPSED,
  loadSideEditorCollapsed,
  saveSideEditorCollapsed,
  SIDE_EDITOR_COLLAPSED_KEY,
} from './sideEditorLayout'

const memory = new Map<string, string>()

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadSideEditorCollapsed', () => {
  it('defaults to collapsed for side-terminal layout', () => {
    expect(DEFAULT_SIDE_EDITOR_COLLAPSED).toBe(true)
    expect(loadSideEditorCollapsed()).toBe(true)
  })

  it('reads persisted values', () => {
    memory.set(SIDE_EDITOR_COLLAPSED_KEY, '0')
    expect(loadSideEditorCollapsed()).toBe(false)
    memory.set(SIDE_EDITOR_COLLAPSED_KEY, '1')
    expect(loadSideEditorCollapsed()).toBe(true)
  })
})

describe('saveSideEditorCollapsed', () => {
  it('persists the collapsed flag', () => {
    saveSideEditorCollapsed(false)
    expect(memory.get(SIDE_EDITOR_COLLAPSED_KEY)).toBe('0')
    expect(loadSideEditorCollapsed()).toBe(false)
    saveSideEditorCollapsed(true)
    expect(memory.get(SIDE_EDITOR_COLLAPSED_KEY)).toBe('1')
  })
})
