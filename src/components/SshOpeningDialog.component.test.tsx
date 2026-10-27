// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SshOpeningDialog from './SshOpeningDialog'
import { cancelSshOpening, runSshOpening, SshPreparationError } from '../store/sshOpeningStore'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({ switchProject: vi.fn() }))
vi.mock('../store/projectStore', () => ({
  useProjectStore: Object.assign((selector: (state: unknown) => unknown) => selector({ sshConnections: [] }), {
    getState: () => ({ switchProject: mocks.switchProject }),
  }),
}))

const project: Project = { id: 'remote', name: 'demo', path: 'ssh://c/home/demo', kind: 'ssh', created_at: 1, last_opened_at: 1 }
afterEach(() => cancelSshOpening())

describe('SshOpeningDialog', () => {
  it('keeps the workspace usable when mounting a project on a ready shared daemon', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('mounting')
      report('service')
      return new Promise(() => {})
    }).catch(error => error)
    render(<SshOpeningDialog />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在打开项目 demo')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-modal-overlay]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect((await opening).name).toBe('AbortError')
  })
  it('shows the terminal preparation stage and allows cancelling without activating a project', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('service', { rootUri: project.path, connectionId: 'c', connectionMode: 'server', phase: 'readyServer', mode: 'server', transport: 'serve', reason: null, version: '1' })
      return new Promise(() => {})
    }).catch(error => error)
    render(<SshOpeningDialog />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在准备远程终端')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await opening).name).toBe('AbortError')
    expect(mocks.switchProject).not.toHaveBeenCalled()
  })

  it('keeps readable failure details and retries the same project', async () => {
    await runSshOpening(project, async () => { throw new SshPreparationError('daemon failed\nnetwork detail') }).catch(() => {})
    render(<SshOpeningDialog />)
    expect(screen.getByRole('alert')).toHaveTextContent('daemon failed network detail')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.switchProject).toHaveBeenCalledWith(project)
  })
})
