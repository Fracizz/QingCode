// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTerminalProgramActivity,
  noteTerminalTitle,
} from '@/lib/terminal/terminalProgramActivity'
import TerminalActivityDot from './TerminalActivityDot'

describe('TerminalActivityDot', () => {
  afterEach(() => {
    clearTerminalProgramActivity('a')
    clearTerminalProgramActivity('b')
  })

  it('keeps an empty slot while idle and pulses only for its own busy terminal', () => {
    const { container } = render(<TerminalActivityDot terminalId="a" exited={false} />)
    expect(container.querySelector('[data-terminal-activity]')).toBeNull()
    expect(container.firstElementChild?.className).toContain('w-3')

    act(() => noteTerminalTitle('b', '⠋ build'))
    expect(container.querySelector('[data-terminal-activity]')).toBeNull()

    act(() => noteTerminalTitle('a', '⠋ Claude Code'))
    expect(screen.getByRole('img').dataset.terminalActivity).toBe('running')
    expect(screen.getByRole('img').className).toContain('dirty-pulse')

    act(() => clearTerminalProgramActivity('a'))
    expect(container.querySelector('[data-terminal-activity]')).toBeNull()
  })

  it('hides the dot once the terminal has exited', () => {
    noteTerminalTitle('a', '⠋ Claude Code')
    const { container } = render(<TerminalActivityDot terminalId="a" exited />)
    expect(container.querySelector('[data-terminal-activity]')).toBeNull()
  })
})
