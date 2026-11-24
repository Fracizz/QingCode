import { describe, expect, it } from 'vitest'
import { bracketedPasteInput, terminalBlockPasteRoute } from './terminalBlockPaste'

describe('terminalBlockPasteRoute', () => {
  it('prefers xterm paste when the program enabled bracketed paste', () => {
    expect(terminalBlockPasteRoute(true, false)).toBe('xterm')
    expect(terminalBlockPasteRoute(true, true)).toBe('xterm')
  })

  it('wraps the paste itself for an AI CLI whose mode flag was lost', () => {
    expect(terminalBlockPasteRoute(false, true)).toBe('wrapped')
  })

  it('refuses a plain shell without bracketed paste', () => {
    expect(terminalBlockPasteRoute(false, false)).toBeNull()
  })
})

describe('bracketedPasteInput', () => {
  it('normalizes newlines to CR inside paste markers', () => {
    expect(bracketedPasteInput('a\nb\r\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~')
  })

  it('strips ESC so the body cannot end the paste early', () => {
    expect(bracketedPasteInput('x\x1b[201~rm -rf /\n')).toBe('\x1b[200~x[201~rm -rf /\r\x1b[201~')
  })
})
