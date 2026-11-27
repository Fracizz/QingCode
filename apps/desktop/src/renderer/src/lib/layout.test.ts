import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  MAIN_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDE_CHAT_DEFAULT_WIDTH,
  clampSidebarWidth,
  parseLayoutPrefs,
  sideChatLayout,
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

describe('sideChatLayout', () => {
  it('并排时保留主对话最小宽度，工作区足够宽时限制侧聊最大宽度', () => {
    expect(sideChatLayout(SIDE_CHAT_DEFAULT_WIDTH, 1000)).toEqual({ docked: true, min: 320, max: 520, width: 420 })
    expect(sideChatLayout(650, 1000).width).toBe(1000 - MAIN_MIN_WIDTH)
    expect(sideChatLayout(999, 1600).width).toBe(720)
  })

  it('窄工作区用浮层，并在空间继续缩小时缩小面板', () => {
    expect(sideChatLayout(600, 620)).toEqual({ docked: false, min: 320, max: 572, width: 572 })
    expect(sideChatLayout(600, 300)).toEqual({ docked: false, min: 252, max: 252, width: 252 })
  })
})

describe('parseLayoutPrefs', () => {
  it('空值与损坏 JSON 使用默认', () => {
    expect(parseLayoutPrefs(null)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayoutPrefs('{oops')).toEqual(DEFAULT_LAYOUT)
  })

  it('旧布局保留侧栏偏好，聊天宽度使用默认值', () => {
    expect(parseLayoutPrefs('{"sidebarWidth":9999,"sidebarCollapsed":true}')).toEqual({
      sidebarWidth: SIDEBAR_MAX_WIDTH,
      sidebarCollapsed: true,
      chatWidth: 'default',
    })
  })

  it('读取已保存的宽屏偏好', () => {
    expect(parseLayoutPrefs('{"chatWidth":"wide"}')).toEqual({ ...DEFAULT_LAYOUT, chatWidth: 'wide' })
  })

  it('字段类型不对时逐项回落', () => {
    expect(parseLayoutPrefs('{"sidebarWidth":"wide","sidebarCollapsed":"yes","chatWidth":true}')).toEqual(DEFAULT_LAYOUT)
  })
})

describe('windowControlsSide', () => {
  it('macOS 在左，其他平台在右', () => {
    expect(windowControlsSide('darwin')).toBe('left')
    expect(windowControlsSide('win32')).toBe('right')
    expect(windowControlsSide(undefined)).toBe('right')
  })
})
