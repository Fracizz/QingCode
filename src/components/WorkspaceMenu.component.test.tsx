// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceMenu from './WorkspaceMenu'

vi.mock('../lib/namedWorkspaceActions', () => ({
  listNamedWorkspaces: () => [], getActiveNamedWorkspaceId: () => null,
  activateNamedWorkspace: vi.fn(), saveVisibleProjectsAsWorkspace: vi.fn(),
}))
beforeEach(() => localStorage.clear())
describe('workspace menu keyboard navigation', () => {
  it('supports directional navigation, endpoints, and returning focus on Escape', () => {
    render(<WorkspaceMenu />)
    const trigger = screen.getByRole('button', { name: '多项目工作区' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const first = screen.getByRole('menuitem', { name: '将顶栏项目保存为工作区' })
    const last = screen.getByRole('menuitem', { name: '管理多项目工作区' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(last).toHaveFocus()
    fireEvent.keyDown(last, { key: 'Home' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'End' })
    expect(last).toHaveFocus()
    fireEvent.keyDown(last, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitem', { name: '管理多项目工作区' })).toHaveFocus()
  })
})
