// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { publishTerminalActivity } from '@/lib/terminal/terminalActivity'
import TerminalActivityDot from './TerminalActivityDot'

describe('TerminalActivityDot', () => {
  afterEach(() => publishTerminalActivity(new Map()))

  it('keeps an empty slot while idle and follows phase changes for its own terminal', () => {
    const { container } = render(<TerminalActivityDot terminalId="a" />)
    expect(container.querySelector('[data-terminal-activity]')).toBeNull()
    expect(container.firstElementChild?.className).toContain('w-3')

    act(() => publishTerminalActivity(new Map([
      ['a', { phase: 'running', runningSince: 1, source: 'process' }],
      ['b', { phase: 'unseen', runningSince: null, source: null }],
    ])))
    expect(screen.getByRole('img').dataset.terminalActivity).toBe('running')
    expect(screen.getByRole('img').className).toContain('dirty-pulse')

    act(() => publishTerminalActivity(new Map([
      ['a', { phase: 'unseen', runningSince: null, source: null }],
    ])))
    expect(screen.getByRole('img').dataset.terminalActivity).toBe('unseen')
    expect(screen.getByRole('img').className).toContain('bg-ok')
  })
})
