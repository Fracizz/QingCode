// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/tauri', () => ({ safeInvoke: mocks.invoke }))
vi.mock('@/store/projectStore', () => ({
  useProjectStore: { getState: () => ({ pushToast: vi.fn() }) },
}))

import TerminalControlNotice from './TerminalControlNotice'
import { applyTerminalControlPayload, useTerminalControlStore } from '@/store/terminalControlStore'

const phone = { id: 'p', kind: 'device' as const, name: 'Pixel', observe: false, typing: false }
const desktop = { id: null, kind: 'desktop' as const, name: '电脑', observe: false, typing: false }

describe('TerminalControlNotice', () => {
  afterEach(() => {
    cleanup()
    mocks.invoke.mockClear()
    useTerminalControlStore.setState({ controls: {} })
  })

  it('stays hidden while no device shares the terminal', () => {
    applyTerminalControlPayload({ id: 'term-1', rev: 1, viewers: [desktop], sizeOwnerKind: 'desktop' })
    render(<TerminalControlNotice terminalId="term-1" />)
    expect(screen.queryByTestId('terminal-control-notice')).toBeNull()
  })

  it('shows who is watching and typing while the computer keeps typing', async () => {
    applyTerminalControlPayload({
      id: 'term-1', rev: 1, viewers: [desktop, { ...phone, typing: true }],
      sizeOwner: 'Pixel', sizeOwnerKind: 'device', cols: 50, rows: 30,
    })
    render(<TerminalControlNotice terminalId="term-1" />)
    const text = screen.getByTestId('terminal-control-notice').textContent ?? ''
    expect(text).toContain('Pixel 也在看')
    expect(text).toContain('Pixel 正在输入')
    expect(text).toContain('按 Pixel 的尺寸显示')
    fireEvent.click(screen.getByRole('button', { name: '按电脑尺寸' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('按电脑尺寸显示', 'mobile_terminal_take_size', { id: 'term-1' }))
    fireEvent.click(screen.getByRole('button', { name: '独占' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('独占终端', 'mobile_terminal_exclusive', { id: 'term-1', on: true, force: false }))
  })

  it('lets the computer release a device exclusive', async () => {
    applyTerminalControlPayload({
      id: 'term-1', rev: 1, viewers: [desktop, phone], controller: 'Pixel',
      exclusive: 'Pixel', exclusiveKind: 'device', sizeOwnerKind: 'device', sizeOwner: 'Pixel',
    })
    render(<TerminalControlNotice terminalId="term-1" />)
    expect(screen.getByTestId('terminal-control-notice').textContent).toContain('「Pixel」已独占')
    expect(screen.queryByRole('button', { name: '锁定尺寸' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '解除独占' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('解除独占', 'mobile_terminal_exclusive', { id: 'term-1', on: false, force: true }))
  })

  it('drops payloads older than the current state', () => {
    applyTerminalControlPayload({ id: 'term-1', rev: 5, viewers: [desktop, phone] })
    applyTerminalControlPayload({ id: 'term-1', rev: 4, removed: true })
    expect(useTerminalControlStore.getState().controls['term-1']).toBeTruthy()
    applyTerminalControlPayload({ id: 'term-1', rev: 6, removed: true })
    expect(useTerminalControlStore.getState().controls['term-1']).toBeUndefined()
  })
})
