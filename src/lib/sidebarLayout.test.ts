import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_BAR_WIDTH,
  clampWorkbenchPageWidth,
  getDefaultWorkbenchPageWidth,
  getWorkbenchPageMaxWidth,
  loadWorkbenchPageWidth,
  saveWorkbenchPageWidth,
  WORKBENCH_PAGE_MIN_WIDTH,
  WORKBENCH_PAGE_TERMINAL_RESERVE,
  WORKBENCH_PAGE_WIDTH_KEY,
} from './sidebarLayout'

describe('workbench page width', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', { innerWidth: 1648, innerHeight: 900 })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to half of the workspace instead of the narrow sidebar width', () => {
    expect(getDefaultWorkbenchPageWidth()).toBe((1648 - ACTIVITY_BAR_WIDTH) / 2)
    expect(loadWorkbenchPageWidth()).toBe(800)
  })

  it('keeps room for the terminal and never drops below the page minimum', () => {
    const max = 1648 - ACTIVITY_BAR_WIDTH - WORKBENCH_PAGE_TERMINAL_RESERVE
    expect(getWorkbenchPageMaxWidth()).toBe(max)
    expect(clampWorkbenchPageWidth(5000)).toBe(max)
    expect(clampWorkbenchPageWidth(100)).toBe(WORKBENCH_PAGE_MIN_WIDTH)
  })

  it('persists separately from the sidebar width', () => {
    saveWorkbenchPageWidth(900)
    expect(localStorage.getItem(WORKBENCH_PAGE_WIDTH_KEY)).toBe('900')
    expect(loadWorkbenchPageWidth()).toBe(900)
  })
})
