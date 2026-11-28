// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRateLimits } from '../store/rateLimits'
import { ResetCredits } from './ResetCredits'

it('确认后才使用重置卡，没有明细时由 Codex 选卡', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useRateLimits.getState()
  const consumeResetCredit = vi.fn(async () => undefined)
  useRateLimits.setState({ consumeResetCredit })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === label)
    if (!button) throw new Error(`缺少按钮 ${label}`)
    await act(() => button.click())
  }
  const entry = {
    snapshot: null, account: null, updatedAt: null, loading: false, error: null, costByThread: {},
    resetCredits: { availableCount: 2, credits: [] },
  }
  try {
    await act(() => root.render(<ResetCredits targetId="local" entry={entry} opened now={0} />))
    expect(host.textContent).toContain('可用 2 张')
    await click('使用一张')
    await click('取消')
    expect(consumeResetCredit).not.toHaveBeenCalled()
    await click('使用一张')
    await click('确认使用')
    expect(consumeResetCredit).toHaveBeenCalledExactlyOnceWith('local', null)
  } finally {
    await act(() => root.unmount())
    host.remove()
    useRateLimits.setState(initial)
    vi.unstubAllGlobals()
  }
})
