// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FileTabs } from './FileTabs'
import { createTab } from './filesModel'
import { useFiles } from './filesStore'

vi.mock('../workspace/serverCall', () => ({ onServerEvt: vi.fn(), serverCall: vi.fn() }))
vi.mock('../../lib/cn', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }))
vi.mock('../../components/ui', () => ({ IconButton: () => null }))
vi.mock('radix-ui', () => ({
  ContextMenu: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Trigger: ({ children }: { children: ReactNode }) => children,
  },
}))
vi.mock('../../components/primitives', () => ({
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, disabled, onSelect }: { children: ReactNode; disabled?: boolean; onSelect: () => void }) =>
    <button disabled={disabled} onClick={onSelect}>{children}</button>,
  ContextMenuSeparator: () => null,
}))

it.each([
  ['关闭标签', ['left', 'right', 'outside']],
  ['关闭其他标签', ['middle', 'outside']],
  ['关闭左侧标签', ['middle', 'right', 'outside']],
  ['关闭右侧标签', ['left', 'middle', 'outside']],
  ['关闭全部标签', ['outside']],
])('%s按菜单所属标签和当前面板的顺序处理', async (label, remaining) => {
  const visible = ['left', 'middle', 'right'].map((id) =>
    createTab({ kind: 'file', targetId: 'local', path: `/project/${id}.ts` }, id))
  const outside = createTab({ kind: 'file', targetId: 'local', path: '/other/outside.ts' }, 'outside')
  useFiles.setState({ tabs: [...visible, outside], activeId: 'left' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const action = (tab: Element | undefined, name: string) => {
    const button = Array.from(tab?.parentElement?.querySelectorAll('button') ?? [])
      .find((item) => item.textContent?.trim() === name)
    expect(button).toBeDefined()
    return button!
  }
  try {
    await act(() => root.render(<FileTabs tabs={visible} activeId={undefined} />))
    const [left, middle, right] = host.querySelectorAll('[role="tab"]')
    expect(action(left, '关闭左侧标签').disabled).toBe(true)
    expect(action(right, '关闭右侧标签').disabled).toBe(true)
    await act(() => action(middle, label).click())
    expect(useFiles.getState().tabs.map((tab) => tab.id)).toEqual(remaining)
  } finally {
    await act(() => root.unmount())
    host.remove()
    useFiles.getState().closeAll()
    vi.unstubAllGlobals()
  }
})
