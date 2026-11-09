// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Tooltip from './Tooltip'

describe('Tooltip placement', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens below a trigger that has no room above instead of covering it', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100, right: 200, top: 40, bottom: 68, width: 100, height: 28, x: 100, y: 40, toJSON: () => ({}),
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(72)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120)

    render(<Tooltip label={'标题\n命令\nShell'} side="top" delay={0}><button type="button">tab</button></Tooltip>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'tab' }).parentElement!)

    const tip = await screen.findByRole('tooltip')
    expect(tip.style.top).toBe('76px')
  })
})
