// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PrewarmPoolBadge from './PrewarmPoolBadge'

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('@/lib/tauri', () => ({ safeInvoke: (...args: unknown[]) => invoke(...(args as [])) }))

const translate = (key: string, params?: Record<string, string | number>) =>
  key.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
const recent = { hit: 0, miss: 0, missReasons: {} }

describe('PrewarmPoolBadge', () => {
  beforeEach(() => invoke.mockClear())

  it('Shell 与 CLI 池各自显示就绪/目标并分别着色', () => {
    render(
      <PrewarmPoolBadge
        hostKey="ssh:conn"
        scoped={{ cwd: 'ssh://conn/D:/a', status: { target: 1, ready: 1, profile: { target: 2, ready: 0, reason: 'cli_anchor_busy' } }, recent }}
        translate={translate}
      />,
    )
    const shell = screen.getByRole('img', { name: 'Shell 预热 1/1' })
    expect(shell).toHaveTextContent('1/1')
    expect(shell).toHaveAttribute('data-prewarm-tone', 'full')
    const cli = screen.getByRole('img', { name: 'CLI 预热 0/2' })
    expect(cli).toHaveTextContent('0/2')
    expect(cli).toHaveAttribute('data-prewarm-tone', 'paused')
  })

  it('双击重新触发预热，单击不冒泡到主机标题', () => {
    const onClick = vi.fn()
    render(
      <div onClick={onClick}>
        <PrewarmPoolBadge
          hostKey="ssh:conn"
          scoped={{ cwd: 'ssh://conn/D:/a', status: { target: 0, ready: 0, profile: { target: 2, ready: 0, reason: 'profile_exited' } }, recent }}
          translate={translate}
        />
      </div>,
    )
    const cli = screen.getByRole('img', { name: 'CLI 预热 0/2' })
    fireEvent.click(cli)
    fireEvent.doubleClick(cli)
    expect(onClick).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith(expect.any(String), 'shell_prewarm_retry', { cwd: 'ssh://conn/D:/a' })
  })

  it('预热未开启时不渲染', () => {
    const { container } = render(
      <PrewarmPoolBadge hostKey="local" scoped={{ cwd: 'D:/a', status: { target: 0, ready: 0, reason: 'no_target' }, recent }} translate={translate} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
