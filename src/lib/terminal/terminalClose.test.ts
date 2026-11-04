import { describe, expect, it } from 'vitest'
import { terminalCloseButtonAction } from '@/lib/terminal/terminalClose'

describe('terminalCloseButtonAction', () => {
  it('arms a live session on the first click', () => {
    expect(terminalCloseButtonAction('running', false)).toBe('arm')
    expect(terminalCloseButtonAction('starting', false)).toBe('arm')
  })

  it('closes a live session only after it is armed', () => {
    expect(terminalCloseButtonAction('running', true)).toBe('close')
    expect(terminalCloseButtonAction('starting', true)).toBe('close')
  })

  it('closes an exited session on the first click', () => {
    expect(terminalCloseButtonAction('exited', false)).toBe('close')
    expect(terminalCloseButtonAction('exited', true)).toBe('close')
  })

  it('ignores a click with no session', () => {
    expect(terminalCloseButtonAction(undefined, false)).toBe('ignore')
  })
})
