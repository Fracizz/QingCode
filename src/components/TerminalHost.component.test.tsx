// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TerminalHosts, TerminalSlot } from './TerminalHost'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('./Terminal', () => ({
  default: function FakeTerminal({ terminalId, isActive }: { terminalId: string; isActive: boolean }) {
    useEffect(() => {
      lifecycle.mounts += 1
      return () => {
        lifecycle.unmounts += 1
      }
    }, [])
    return <div data-testid={`view-${terminalId}`} data-active={String(isActive)} />
  },
}))

function Layout({
  slot,
  entries = [{ terminalId: 't1', isActive: true }],
  onPointerDown,
}: {
  slot: 'left' | 'right' | 'none'
  entries?: { terminalId: string; isActive: boolean }[]
  onPointerDown?: () => void
}) {
  return (
    <>
      <TerminalHosts entries={entries} layoutKey="k" />
      <div data-testid="left">
        {slot === 'left' && <TerminalSlot terminalId="t1" onPointerDown={onPointerDown} />}
      </div>
      <div data-testid="right">{slot === 'right' && <TerminalSlot terminalId="t1" />}</div>
    </>
  )
}

describe('terminal host', () => {
  it('moves the live view between slots without remounting it (VS Code attachToElement)', async () => {
    lifecycle.mounts = 0
    lifecycle.unmounts = 0
    const view = render(<Layout slot="left" />)
    await waitFor(() => expect(screen.getByTestId('view-t1')).toBeInTheDocument())
    expect(screen.getByTestId('left')).toContainElement(screen.getByTestId('view-t1'))

    view.rerender(<Layout slot="right" />)
    expect(screen.getByTestId('right')).toContainElement(screen.getByTestId('view-t1'))

    // 没有槽位时视图游离在文档外，但仍然挂载。
    view.rerender(<Layout slot="none" />)
    expect(screen.queryByTestId('view-t1')).toBeNull()
    view.rerender(<Layout slot="left" />)
    expect(screen.getByTestId('left')).toContainElement(screen.getByTestId('view-t1'))

    expect(lifecycle.mounts).toBe(1)
    expect(lifecycle.unmounts).toBe(0)

    view.rerender(<Layout slot="none" entries={[]} />)
    expect(lifecycle.unmounts).toBe(1)
  })

  it('activates the pane through a native listener on the slot', async () => {
    const activate = vi.fn()
    render(<Layout slot="left" onPointerDown={activate} />)
    await waitFor(() => expect(screen.getByTestId('view-t1')).toBeInTheDocument())
    fireEvent.pointerDown(screen.getByTestId('view-t1'))
    expect(activate).toHaveBeenCalledTimes(1)
  })
})
