import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_BAR_WIDTH,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_EDITOR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
} from './sidebarLayout'

describe('sidebar width', () => {
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

  it('preserves the shared saved sidebar width even when an older page width exists', () => {
    localStorage.setItem('qingcode:workbench-page-width', '696')
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    saveSidebarWidth(440)
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('440')
    expect(loadSidebarWidth()).toBe(440)
  })

  it('keeps space for the work area on a narrow window', () => {
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH)
    vi.stubGlobal('window', { innerWidth: 700 })
    expect(clampSidebarWidth(5000)).toBe(700 - ACTIVITY_BAR_WIDTH - SIDEBAR_EDITOR_MIN_WIDTH)
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('retains the migration of legacy default widths', () => {
    for (const width of ['260', '300']) {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, width)
      expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    }
  })
})
