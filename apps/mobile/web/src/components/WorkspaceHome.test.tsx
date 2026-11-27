// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useApp } from '../store'
import { useWorkspace } from '../workspace'
import { WorkspaceHome } from './WorkspaceHome'

it('从纵向主机列表切换项目筛选并恢复全部项目', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const dialog = HTMLDialogElement.prototype
  const methods = {
    showModal(this: HTMLDialogElement) { this.open = true },
    close(this: HTMLDialogElement) { this.open = false },
  }
  const originals = Object.entries(methods).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(dialog, name)
    Object.defineProperty(dialog, name, { value, configurable: true })
    return { name, descriptor }
  })
  const app = useApp.getState()
  const workspace = useWorkspace.getState()
  const host = document.createElement('div')
  const root = createRoot(host)
  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-expanded]')
  const option = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('dialog button[aria-pressed]')]
    .find((button) => button.textContent === text)

  try {
    await act(() => {
      useApp.setState({
        activeId: 'desktop',
        loadTargets: vi.fn().mockResolvedValue(undefined),
        targets: [
          { id: 'local', name: '本机', kind: 'local' },
          { id: 'ssh', name: 'CI 主机', kind: 'ssh', host: 'ci.test', port: 22, username: 'runner', auth: { kind: 'agent' } },
        ],
      })
      useWorkspace.setState({
        tab: 'projects',
        loadProjects: vi.fn().mockResolvedValue(undefined),
        projects: { desktop: { loading: false, error: false, loaded: true, items: [
          { id: 'a', targetId: 'local', name: '本地项目', path: '/local/a', lastOpenedAt: 0 },
          { id: 'b', targetId: 'ssh', name: '远端项目', path: '/srv/b', lastOpenedAt: 0 },
        ] } },
      })
      root.render(<WorkspaceHome />)
    })

    expect(trigger()?.textContent).toContain('全部主机')
    expect(host.textContent).toContain('本地项目')
    expect(host.textContent).toContain('远端项目')
    expect(option('CI 主机')).toBeUndefined()
    await act(() => trigger()?.click())
    expect(option('全部主机')?.getAttribute('aria-pressed')).toBe('true')
    await act(() => option('CI 主机')?.click())
    expect(trigger()?.textContent).toContain('CI 主机')
    expect(host.querySelector('dialog')).toBeNull()
    expect(host.textContent).not.toContain('本地项目')
    expect(host.textContent).toContain('远端项目')
    await act(() => trigger()?.click())
    expect(option('CI 主机')?.getAttribute('aria-pressed')).toBe('true')
    await act(() => option('全部主机')?.click())
    expect(host.textContent).toContain('本地项目')
  } finally {
    await act(() => root.unmount())
    useApp.setState(app)
    useWorkspace.setState(workspace)
    for (const { name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(dialog, name, descriptor)
      else Reflect.deleteProperty(dialog, name)
    }
    vi.unstubAllGlobals()
  }
})
