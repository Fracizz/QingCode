import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_BAR_WIDTH,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_EDITOR_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  getSidebarPageMinWidth,
  SIDEBAR_PAGE_MIN_WIDTH,
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
    // 宽窗口：普通侧栏上限为窗口 1/2，整页为 2/3
    expect(clampSidebarWidth(5000)).toBe(1648 / 2)
    expect(clampSidebarWidth(5000, true)).toBe(Math.floor(1648 * 2 / 3))
    vi.stubGlobal('window', { innerWidth: 700 })
    expect(clampSidebarWidth(5000)).toBe(700 - ACTIVITY_BAR_WIDTH - SIDEBAR_EDITOR_MIN_WIDTH)
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('raises full pages to their own minimum without exceeding the window limit', () => {
    // 宽窗口：整页默认占工作区一半，可拖宽到 2/3
    const half = Math.round((1648 - ACTIVITY_BAR_WIDTH) / 2)
    expect(getSidebarPageMinWidth()).toBe(half)
    expect(clampSidebarWidth(320, true)).toBe(half)
    expect(clampSidebarWidth(1000, true)).toBe(1000)
    vi.stubGlobal('window', { innerWidth: 800 })
    // 窄窗口：一半不足时用绝对下限，但仍让位于给工作区留的空间
    expect(SIDEBAR_PAGE_MIN_WIDTH).toBeGreaterThan(800 - ACTIVITY_BAR_WIDTH - SIDEBAR_EDITOR_MIN_WIDTH)
    expect(clampSidebarWidth(320, true)).toBe(800 - ACTIVITY_BAR_WIDTH - SIDEBAR_EDITOR_MIN_WIDTH)
  })

  it('retains the migration of legacy default widths', () => {
    for (const width of ['260', '300']) {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, width)
      expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    }
  })
})
