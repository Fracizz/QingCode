// @vitest-environment jsdom
import { pickSnapshot, type RateLimitSnapshot } from '@qn/codex-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAgentSettings } from '../agents'
import type { RateLimitEntry } from '../store'
import { AgentQuota, RateLimitDetails, TargetRateLimits } from './RateLimitView'

const state = vi.hoisted(() => ({
  rateLimits: {} as Record<string, RateLimitEntry>,
  claudeRateLimits: {} as Record<string, RateLimitSnapshot>,
  agentSettings: null as MobileAgentSettings | null,
  sessions: {} as Record<string, { opened: boolean }>,
  ensureOpen: vi.fn(),
  refreshRateLimits: vi.fn(),
}))

vi.mock('../store', () => ({
  useApp: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }),
}))
vi.mock('./ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ui')>(),
  Dialog: ({ title, onClose, children }: React.ComponentProps<typeof import('./ui').Dialog>) => (
    <section aria-label={title}>{children}<button type="button" onClick={onClose}>关闭</button></section>
  ),
}))

afterEach(() => {
  state.rateLimits = {}
  state.claudeRateLimits = {}
  state.agentSettings = null
  state.sessions = {}
  vi.clearAllMocks()
})

describe('手机目标额度展示', () => {
  it('状态栏推送分别显示 Claude 的 5 小时与每周额度', () => {
    const snapshot = pickSnapshot({ rateLimits: {
      limitId: 'claude-statusline',
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 58, windowDurationMins: 10_080 },
    } })
    if (!snapshot) throw new Error('缺少 Claude 状态栏额度')
    state.claudeRateLimits.local = snapshot
    const html = renderToStaticMarkup(<AgentQuota targetId="local" agent="claude" />)
    expect(html).toContain('5 小时')
    expect(html).toContain('每周')
    expect(html).toContain('剩余 100%')
    expect(html).toContain('剩余 42%')
    expect(html).toContain('来源为 Claude CLI 状态栏')
  })

  it('Claude 未收到限额事件时在对话中说明状态，pi 没有账户额度入口', () => {
    const claude = renderToStaticMarkup(<AgentQuota targetId="local" agent="claude" />)
    expect(claude).toContain('暂无限额上报')
    expect(claude).toContain('Claude 只在接近或触发限额时上报。')
    expect(renderToStaticMarkup(<AgentQuota targetId="local" agent="pi" />)).toBe('')
  })

  it('同一目标的 Codex 和 Claude 各自显示剩余额度，pi 不显示额度', () => {
    state.agentSettings = { defaultAgent: 'pi', agents: {} }
    state.rateLimits.local = {
      snapshot: pickSnapshot({ rateLimits: {
        primary: { usedPercent: 32, windowDurationMins: 300 },
        secondary: { usedPercent: 12, windowDurationMins: 10080 },
      } }),
      account: null, loading: false, error: null, updatedAt: null,
    }
    const claude = pickSnapshot({ rateLimits: { primary: { usedPercent: 56 } } })
    if (!claude) throw new Error('缺少 Claude 限额样例')
    state.claudeRateLimits.local = claude

    const html = renderToStaticMarkup(<TargetRateLimits targetId="local" targetName="本机" available />)
    expect(html).toContain('Codex 剩余 5h 68% · 周 88%')
    expect(html).toContain('Claude 上报剩余 44%')
    expect(html).not.toContain('pi 额度')
    const remote = renderToStaticMarkup(<TargetRateLimits targetId="remote" targetName="远端" available />)
    expect(remote).toContain('Codex 额度详情')
    expect(remote).not.toMatch(/剩余|Claude 额度/)
  })

  it('仅启用 pi 的目标不会显示其他 CLI 缓存的额度', () => {
    state.agentSettings = { defaultAgent: 'pi', agents: { remote: { codex: { enabled: false }, claude: { enabled: false } } } }
    state.rateLimits.remote = {
      snapshot: pickSnapshot({ rateLimits: { secondary: { usedPercent: 29 } } }),
      account: null, loading: false, error: null, updatedAt: null,
    }

    expect(renderToStaticMarkup(<TargetRateLimits targetId="remote" targetName="远端" available />)).toBe('')
  })

  it('单窗口详情按剩余值画进度条，保留按用量判断的警告色', () => {
    state.rateLimits.local = {
      snapshot: pickSnapshot({ rateLimits: { secondary: { usedPercent: 81 } } }),
      account: null, loading: false, error: null, updatedAt: null,
    }

    const details = renderToStaticMarkup(<RateLimitDetails targetId="local" available />)
    expect(details).toContain('每周')
    expect(details).toContain('最低剩余 19%')
    expect(details).toContain('width:19%;background:var(--color-qn-warn)')
    expect(details).not.toContain('5 小时')
  })

  it('无额度数据时已连接目标仍可打开 Codex 额度详情并刷新', () => {
    state.rateLimits.local = {
      snapshot: null, account: null, loading: false, error: '读取额度失败', updatedAt: null,
    }

    expect(renderToStaticMarkup(<TargetRateLimits targetId="local" targetName="本机" available={false} />)).toBe('')
    expect(renderToStaticMarkup(<TargetRateLimits targetId="local" targetName="本机" available />)).toContain('Codex 额度详情')
    const details = renderToStaticMarkup(<RateLimitDetails targetId="local" available />)
    expect(details).toContain('读取额度失败')
    expect(details).toContain('>刷新</button>')
  })

  it('仅显式刷新 Codex 时访问对应目标，Claude 详情只显示已上报的数据', async () => {
    state.agentSettings = { defaultAgent: 'pi', agents: {} }
    const claude = pickSnapshot({ rateLimits: { primary: { usedPercent: 75 } } })
    if (!claude) throw new Error('缺少 Claude 限额样例')
    state.claudeRateLimits.remote = claude
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('div')
    const root = createRoot(host)
    async function click(label: string) {
      const button = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent === label)
      if (!button) throw new Error(`缺少按钮 ${label}`)
      await act(() => button.click())
    }

    try {
      await act(() => root.render(<TargetRateLimits targetId="remote" targetName="远端" available />))
      await click('Claude 额度详情，上报剩余 25%')
      expect(host.querySelector('[aria-label="远端 · Claude 额度"]')?.textContent).toContain('上报剩余 25%')
      await click('关闭')
      await click('Codex 额度详情')
      expect(host.querySelector('[aria-label="远端 · Codex 额度"]')).toBeTruthy()
      expect(state.ensureOpen).not.toHaveBeenCalled()
      expect(state.refreshRateLimits).not.toHaveBeenCalled()

      await click('刷新')
      expect(state.ensureOpen).toHaveBeenCalledExactlyOnceWith('remote', 'codex')
      expect(state.refreshRateLimits).not.toHaveBeenCalled()

      state.sessions['codex:remote'] = { opened: true }
      await click('刷新')
      expect(state.ensureOpen).toHaveBeenCalledTimes(1)
      expect(state.refreshRateLimits).toHaveBeenCalledExactlyOnceWith('remote')
    } finally {
      await act(() => root.unmount())
      vi.unstubAllGlobals()
    }
  })
})
