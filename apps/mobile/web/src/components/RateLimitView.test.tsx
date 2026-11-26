import { pickSnapshot } from '@qn/codex-client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RateLimitEntry } from '../store'
import { RateLimitBadge, RateLimitDetails } from './RateLimitView'

const state = vi.hoisted(() => ({
  rateLimits: {} as Record<string, RateLimitEntry>,
  refreshRateLimits: vi.fn(),
}))

vi.mock('../store', () => ({ useApp: (select: (value: typeof state) => unknown) => select(state) }))

afterEach(() => { state.rateLimits = {} })

describe('手机 Codex 额度展示', () => {
  it('列表徽标和对话按钮都显示剩余百分比', () => {
    state.rateLimits.local = {
      snapshot: pickSnapshot({ rateLimits: {
        primary: { usedPercent: 32, windowDurationMins: 300 },
        secondary: { usedPercent: 12, windowDurationMins: 10080 },
      } }),
      account: null, loading: false, error: null, updatedAt: null,
    }

    expect(renderToStaticMarkup(<RateLimitBadge targetId="local" hideWhenEmpty />)).toContain('剩余 5h 68% · 周 88%')
    expect(renderToStaticMarkup(<RateLimitBadge targetId="local" onToggle={() => {}} />)).toContain('剩余 5h 68% · 周 88%')
  })

  it('单窗口详情按剩余值画进度条，保留按用量判断的警告色', () => {
    state.rateLimits.local = {
      snapshot: pickSnapshot({ rateLimits: { secondary: { usedPercent: 81 } } }),
      account: null, loading: false, error: null, updatedAt: null,
    }

    const details = renderToStaticMarkup(<RateLimitDetails targetId="local" />)
    expect(details).toContain('每周')
    expect(details).toContain('最低剩余 19%')
    expect(details).toContain('width:19%;background:var(--color-qn-warn)')
    expect(details).not.toContain('5 小时')
  })

  it('无额度数据时列表隐藏徽标，对话仍可打开详情并刷新', () => {
    state.rateLimits.local = {
      snapshot: null, account: null, loading: false, error: '读取额度失败', updatedAt: null,
    }

    expect(renderToStaticMarkup(<RateLimitBadge targetId="local" hideWhenEmpty />)).toBe('')
    expect(renderToStaticMarkup(<RateLimitBadge targetId="local" onToggle={() => {}} />)).toContain('<button')
    const details = renderToStaticMarkup(<RateLimitDetails targetId="local" />)
    expect(details).toContain('读取额度失败')
    expect(details).toContain('>刷新</button>')
  })
})
