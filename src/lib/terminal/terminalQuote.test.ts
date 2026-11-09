import { describe, expect, it } from 'vitest'
import { formatTerminalQuote } from './terminalQuote'

describe('formatTerminalQuote', () => {
  it('quotes each line and trims grid padding', () => {
    expect(formatTerminalQuote('提交：65b43a8 feat   \r\n推送：origin/test  ')).toBe(
      '> 提交：65b43a8 feat\n> 推送：origin/test\n'
    )
  })

  it('drops surrounding blank lines but keeps inner ones', () => {
    expect(formatTerminalQuote('\n  \na\n\nb\n   \n')).toBe('> a\n>\n> b\n')
  })

  it('returns empty for whitespace-only selection', () => {
    expect(formatTerminalQuote(' \n\t\n')).toBe('')
  })
})
