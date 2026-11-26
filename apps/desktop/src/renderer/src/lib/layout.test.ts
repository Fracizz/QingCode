import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  MAIN_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseLayoutPrefs,
  windowControlsSide,
} from './layout'

describe('clampSidebarWidth', () => {
  it('限制在最小与最大宽度之间', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(300.4)).toBe(300)
  })

  it('窄窗口时给主区留出最小宽度', () => {
    expect(clampSidebarWidth(400, 800)).toBe(800 - MAIN_MIN_WIDTH)
  })

  it('窗口极窄时仍不低于最小宽度', () => {
    expect(clampSidebarWidth(400, 500)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('非法数值回落到默认宽度', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

describe('parseLayoutPrefs', () => {
  it('空值与损坏 JSON 使用默认', () => {
    expect(parseLayoutPrefs(null)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayoutPrefs('{oops')).toEqual(DEFAULT_LAYOUT)
  })

  it('读取并约束已保存的值', () => {
    expect(parseLayoutPrefs('{"sidebarWidth":9999,"sidebarCollapsed":true}')).toEqual({
      sidebarWidth: SIDEBAR_MAX_WIDTH,
      sidebarCollapsed: true,
    })
  })

  it('字段类型不对时逐项回落', () => {
    expect(parseLayoutPrefs('{"sidebarWidth":"wide","sidebarCollapsed":"yes"}')).toEqual(DEFAULT_LAYOUT)
  })
})

describe('windowControlsSide', () => {
  it('macOS 在左，其他平台在右', () => {
    expect(windowControlsSide('darwin')).toBe('left')
    expect(windowControlsSide('win32')).toBe('right')
    expect(windowControlsSide(undefined)).toBe('right')
  })
})
