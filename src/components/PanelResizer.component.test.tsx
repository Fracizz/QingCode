// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PanelResizer from './PanelResizer'

describe('PanelResizer keyboard controls', () => {
  it('clamps arrow steps, supports bounds and resets without pointer input', () => {
    const change = vi.fn()
    const reset = vi.fn()
    render(<PanelResizer orientation="vertical" active={false} tooltip="调整宽度" ariaValueNow={195} ariaValueMin={100} ariaValueMax={200} onValueChange={change} onReset={reset} />)
    const separator = screen.getByRole('separator')
    expect(separator).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(change).toHaveBeenLastCalledWith(200)
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true })
    expect(change).toHaveBeenLastCalledWith(145)
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(change).toHaveBeenLastCalledWith(100)
    fireEvent.keyDown(separator, { key: 'End' })
    expect(change).toHaveBeenLastCalledWith(200)
    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(reset).toHaveBeenCalledOnce()
  })
})
