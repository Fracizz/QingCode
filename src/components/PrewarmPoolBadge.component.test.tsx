// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PrewarmPoolBadge from './PrewarmPoolBadge'

const translate = (key: string, params?: Record<string, string | number>) =>
  key.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
const recent = { hit: 0, miss: 0, missReasons: {} }

describe('PrewarmPoolBadge', () => {
  it('显示 CLI 池的就绪/目标，暂停时标为 paused', () => {
    render(
      <PrewarmPoolBadge
        hostKey="ssh:conn"
        scoped={{ status: { target: 2, ready: 2, profile: { target: 2, ready: 1, reason: 'profile_exited' } }, recent }}
        translate={translate}
      />,
    )
    const badge = screen.getByRole('img', { name: 'CLI 预热 1/2' })
    expect(badge).toHaveTextContent('1/2')
    expect(badge).toHaveAttribute('data-prewarm-tone', 'paused')
    expect(badge).toHaveAttribute('data-terminal-host-prewarm', 'ssh:conn')
  })

  it('预热未开启时不渲染', () => {
    const { container } = render(
      <PrewarmPoolBadge hostKey="local" scoped={{ status: { target: 0, ready: 0, reason: 'no_target' }, recent }} translate={translate} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
