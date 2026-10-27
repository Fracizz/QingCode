// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { terminalContent, terminalExportName } from './terminalContent'

vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
})

const terminals: Terminal[] = []
function terminal(cols = 12, rows = 3) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 100 })
  terminals.push(term)
  return term
}
const write = (term: Terminal, text: string) =>
  new Promise<void>(resolve => term.write(text, resolve))
afterEach(() => terminals.splice(0).forEach(term => term.dispose()))

describe('terminal text snapshots', () => {
  it('copies the scrolled viewport without moving the cursor', async () => {
    const term = terminal()
    await write(term, 'one\r\ntwo\r\nthree\r\nfour\r\nfive')
    term.scrollToTop()
    const before = [
      term.buffer.active.viewportY,
      term.buffer.active.cursorX,
      term.buffer.active.cursorY,
    ]
    expect(terminalContent(term, 'screen')).toBe('one\ntwo\nthree')
    expect(terminalContent(term, 'buffer')).toBe('one\ntwo\nthree\nfour\nfive')
    expect([
      term.buffer.active.viewportY,
      term.buffer.active.cursorX,
      term.buffer.active.cursorY,
    ]).toEqual(before)
  })

  it('joins soft wraps while preserving spaces, indentation and actual blank lines', async () => {
    const term = terminal(8, 8)
    await write(term, '1234567 abcdefghijkl\r\n\r\n  code\r\n')
    expect(terminalContent(term, 'buffer')).toBe('1234567 abcdefghijkl\n\n  code')
  })

  it('reads the current alternate-screen rendering, not stale repaint bytes or normal history', async () => {
    const term = terminal(24, 4)
    await write(term, 'old shell history\x1b[?1049h\x1b[H\x1b[31m处理中\x1b[0m\r\nold answer')
    await write(term, '\x1b[2;1H\x1b[2Knew answer')
    expect(terminalContent(term, 'screen')).toBe('处理中\nnew answer')
    expect(terminalContent(term, 'buffer')).not.toContain('old')
    await write(term, '\x1b[?1049l')
    expect(terminalContent(term, 'buffer')).toBe('old shell history')
  })

  it('preserves CJK and wide glyphs across wraps', async () => {
    const term = terminal(8, 4)
    await write(term, '中文测试再来\r\n  下一行')
    expect(terminalContent(term, 'buffer')).toBe('中文测试再来\n  下一行')
    const odd = terminal(7, 4)
    await write(odd, '中文测试再来\r\na  中文测试')
    expect(terminalContent(odd, 'buffer')).toBe('中文测试再来\na  中文测试')
  })

  it('makes portable filenames', () => {
    expect(terminalExportName('Claude: /测试*', new Date('2026-10-27T12:00:00Z'))).toBe(
      'Claude_ _测试_-2026-10-27T12-00-00-000Z.txt'
    )
  })
})
