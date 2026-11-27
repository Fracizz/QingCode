// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../../shared/backendApi'
import { useTargets } from '../../store/targets'
import { ForceUpdateDialog, TargetSectionHeader } from './TargetSwitcher'

vi.mock('../../lib/cn', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }))
vi.mock('../primitives', () => {
  const childrenOnly = ({ children }: { children: ReactNode }) => children
  return {
    Menu: childrenOnly,
    MenuContent: childrenOnly,
    MenuTrigger: childrenOnly,
    MenuSeparator: () => null,
    MenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
      <button onClick={onSelect}>{children}</button>
    ),
    PopoverRoot: childrenOnly,
    PopoverTrigger: childrenOnly,
    PopoverContent: childrenOnly,
  }
})
vi.mock('../ui', () => ({
  EmptyState: () => null,
  ErrorNote: () => null,
  IconButton: () => null,
  Modal: ({ title, description, footer }: { title: string; description: string; footer: ReactNode }) => (
    <section role="dialog"><h2>{title}</h2><p>{description}</p>{footer}</section>
  ),
}))

it('选中强制更新菜单项后，只有确认才提交目标 id', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const target: SshTarget = {
    id: 'remote', kind: 'ssh', name: 'hy-Ubuntu26', host: 'host', port: 22, username: 'user', auth: { kind: 'agent' },
  }
  const forceUpdate = vi.fn(async () => undefined)
  const original = useTargets.getState()
  useTargets.setState({ targets: [target], states: { [target.id]: { id: target.id, state: 'ready' } }, forceUpdate })
  const container = document.createElement('div')
  const root = createRoot(container)
  const noop = () => {}
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === text)
    expect(button).toBeDefined()
    await act(() => button?.click())
  }

  try {
    const actions = { onAdd: noop, onEdit: noop, onSelect: noop, onConnect: noop, onDisconnect: noop, onForgetSecret: noop }
    await act(() => root.render(<>
      <TargetSectionHeader target={target} actions={actions} collapsed={false} onToggle={noop} />
      <ForceUpdateDialog />
    </>))
    await click('强制更新 Server')
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('关闭该目标的终端')
    expect(forceUpdate).not.toHaveBeenCalled()
    await click('取消')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(forceUpdate).not.toHaveBeenCalled()

    await click('强制更新 Server')
    await click('强制更新')
    expect(forceUpdate).toHaveBeenCalledExactlyOnceWith(target.id)
  } finally {
    await act(() => root.unmount())
    useTargets.setState(original)
    vi.unstubAllGlobals()
  }
})
