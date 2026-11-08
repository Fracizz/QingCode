// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/tauri', () => ({ safeInvoke: mocks.invoke }))
vi.mock('@/store/projectStore', () => ({
  useProjectStore: { getState: () => ({ pushToast: vi.fn() }) },
}))

import TerminalControlNotice from './TerminalControlNotice'
import { useTerminalControlStore } from '@/store/terminalControlStore'

describe('TerminalControlNotice', () => {
  afterEach(() => {
    cleanup()
    mocks.invoke.mockClear()
    useTerminalControlStore.setState({ controls: {} })
  })

  it('stays hidden while the computer holds the terminal', () => {
    render(<TerminalControlNotice terminalId="term-1" />)
    expect(screen.queryByTestId('terminal-control-notice')).toBeNull()
  })

  it('names the device and takes a desktop terminal back', async () => {
    useTerminalControlStore.getState().setControl('term-1', { name: 'Pixel', cols: 50, rows: 30 })
    render(<TerminalControlNotice terminalId="term-1" />)
    expect(screen.getByTestId('terminal-control-notice').textContent).toContain('Pixel')
    fireEvent.click(screen.getByRole('button', { name: '接回' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('接回终端', 'mobile_terminal_take', { id: 'term-1' }))
  })

  it('offers take over for a terminal opened on the phone', () => {
    useTerminalControlStore.getState().setControl('mobile-1', { name: 'Pixel', cols: 50, rows: 30 })
    render(<TerminalControlNotice terminalId="mobile-1" />)
    expect(screen.getByRole('button', { name: '接管' })).toBeTruthy()
  })
})
