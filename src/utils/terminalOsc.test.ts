import { describe, expect, it, vi } from 'vitest'
import { parseShellIntegrationOsc, TerminalOscParser } from './terminalOsc'

describe('parseShellIntegrationOsc', () => {
  it('detects FinalTerm and VS Code markers', () => {
    expect(parseShellIntegrationOsc('133;C')).toBe('start')
    expect(parseShellIntegrationOsc('633;C')).toBe('start')
    expect(parseShellIntegrationOsc('133;D;0')).toBe('end')
    expect(parseShellIntegrationOsc('633;A')).toBe('end')
    expect(parseShellIntegrationOsc('133;B')).toBe(null)
    expect(parseShellIntegrationOsc('0;title')).toBe(null)
  })
})

describe('TerminalOscParser shell integration', () => {
  it('fires command start/end and strips sequences from output', () => {
    const parser = new TerminalOscParser()
    const onStart = vi.fn()
    const onEnd = vi.fn()
    const bytes = new TextEncoder().encode(
      'before\x1b]133;C\x07mid\x1b]633;D;0\x07after',
    )
    const out = new TextDecoder().decode(
      parser.feed(bytes, { onCommandStart: onStart, onCommandEnd: onEnd }),
    )
    expect(out).toBe('beforemidafter')
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
