// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TerminalExitNotice from './TerminalExitNotice'

describe('terminal exit evidence notice', () => {
  it('waits for an explicit action and never reopens while rendering an abnormal exit', async () => {
    const reopen = vi.fn(async () => undefined)
    const exportLog = vi.fn(async () => undefined)
    render(<TerminalExitNotice exitCode={1} onReopen={reopen} onExport={exportLog} />)
    expect(screen.getByRole('status')).toHaveTextContent('退出码 1')
    expect(reopen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '导出终端诊断' }))
    await waitFor(() => expect(exportLog).toHaveBeenCalledTimes(1))
    expect(reopen).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: '重新打开终端' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '重新打开终端' }))
    await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1))
  })
})

it('does not claim a process has ended when only reattachment failed', async () => {
  const retry = vi.fn(async () => undefined)
  render(<TerminalExitNotice exitCode={null} restoreUnavailable onReopen={retry} onExport={async () => undefined} />)
  expect(screen.getByRole('status')).toHaveTextContent('暂时无法接回')
  expect(screen.getByRole('status')).not.toHaveTextContent('会话已结束')
  expect(retry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试接回' }))
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
})
