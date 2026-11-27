// @vitest-environment jsdom
import type { TermInfo } from '@qn/protocol'
import { act, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useCodex } from '../../store/codex'
import { useTargets } from '../../store/targets'
import { useTerminalDock } from './dockState'
import { TerminalDock } from './TerminalDock'

const request = vi.hoisted(() => vi.fn<(targetId: string, method: string, params: unknown) => Promise<unknown>>())
vi.mock('../workspace/serverCall', () => ({ serverCall: request }))
vi.mock('./TerminalView', () => ({ default: () => null }))
vi.mock('../../lib/cn', () => ({ cn: (...classes: unknown[]) => classes.filter(Boolean).join(' ') }))
vi.mock('../../components/ui', () => ({
  EmptyState: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ErrorNote: ({ message }: { message: string }) => <p>{message}</p>,
  IconButton: ({ label, children, disabled, onClick }: {
    label: string; children: ReactNode; disabled?: boolean; onClick?: () => void
  }) => <button aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>,
  Spinner: ({ label }: { label: string }) => <p>{label}</p>,
}))

it('打开新终端时保留已有标签并选中新标签，切换面板时接回原标签', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const codex = useCodex.getState()
  const targets = useTargets.getState()
  const dock = useTerminalDock.getState()
  const project = { targetId: 'host', cwd: '/work' }
  const existing: TermInfo = {
    termId: 'old', cwd: project.cwd, shell: '/bin/sh', args: [], pid: 1,
    backend: 'python', supportsResize: true, alive: true, lastSeq: 0,
    cols: 80, rows: 24, startedAt: 1,
  }
  const tabs = [existing]
  request.mockImplementation(async (_targetId, method) => {
    if (method === 'term.list') return { terminals: [...tabs] }
    if (method === 'term.open') {
      const info = { ...existing, termId: `new-${tabs.length}`, shell: '/bin/bash', startedAt: tabs.length + 1 }
      tabs.push(info)
      return info
    }
    return {}
  })
  useCodex.setState({ currentTargetId: project.targetId, currentCwd: project.cwd })
  useTargets.setState({ states: { host: { id: 'host', state: 'ready' } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const selectedTab = () => host.querySelector('[aria-pressed="true"]')?.textContent

  try {
    await act(() => root.render(<StrictMode><TerminalDock /></StrictMode>))
    await act(() => dock.openNew(project))
    expect(request).toHaveBeenCalledWith('host', 'term.open', { cwd: '/work' })
    expect(request.mock.calls.filter(([, method]) => method === 'term.open')).toHaveLength(1)
    expect(host.textContent).toContain('sh 1')
    expect(selectedTab()).toBe('bash 2')

    await act(() => dock.openNew(project))
    expect(request.mock.calls.filter(([, method]) => method === 'term.open')).toHaveLength(2)
    expect(selectedTab()).toBe('bash 3')

    await act(() => dock.close())
    await act(() => dock.toggle())
    expect(request.mock.calls.filter(([, method]) => method === 'term.open')).toHaveLength(2)
    expect(selectedTab()).toBe('bash 3')
  } finally {
    await act(() => root.unmount())
    useCodex.setState(codex, true)
    useTargets.setState(targets, true)
    useTerminalDock.setState(dock, true)
    request.mockReset()
    vi.unstubAllGlobals()
  }
})
