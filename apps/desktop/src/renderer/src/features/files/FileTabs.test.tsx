// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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

afterEach(() => {
  cleanup()
  useFiles.getState().closeAll()
})

it.each([
  ['关闭标签', ['left', 'right', 'outside']],
  ['关闭其他标签', ['middle', 'outside']],
  ['关闭左侧标签', ['middle', 'right', 'outside']],
  ['关闭右侧标签', ['left', 'middle', 'outside']],
  ['关闭全部标签', ['outside']],
])('%s按菜单所属标签和当前面板的顺序处理', (label, remaining) => {
  const visible = ['left', 'middle', 'right'].map((id) =>
    createTab({ kind: 'file', targetId: 'local', path: `/project/${id}.ts` }, id))
  const outside = createTab({ kind: 'file', targetId: 'local', path: '/other/outside.ts' }, 'outside')
  useFiles.setState({ tabs: [...visible, outside], activeId: 'left' })
  const { getAllByRole } = render(<FileTabs tabs={visible} activeId={undefined} />)

  const [left, middle, right] = getAllByRole('tab').map((tab) => within(tab.parentElement!))
  expect((left!.getByRole('button', { name: '关闭左侧标签' }) as HTMLButtonElement).disabled).toBe(true)
  expect((right!.getByRole('button', { name: '关闭右侧标签' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(middle!.getByRole('button', { name: label }))
  expect(useFiles.getState().tabs.map((tab) => tab.id)).toEqual(remaining)
})
