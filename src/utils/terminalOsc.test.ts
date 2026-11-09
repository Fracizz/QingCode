import { describe, expect, it, vi } from 'vitest'
import {
  parseProgramStateOsc,
  parseShellIntegrationOsc,
  registerTerminalOscHandlers,
  SUPPRESSED_OSC_IDENTS,
  type TerminalOscRegistry,
} from './terminalOsc'

function fakeRegistry() {
  const handlers = new Map<number, ((data: string) => boolean)[]>()
  const disposed: number[] = []
  const registry: TerminalOscRegistry = {
    registerOscHandler(ident, callback) {
      handlers.set(ident, [...(handlers.get(ident) ?? []), callback])
      return { dispose: () => disposed.push(ident) }
    },
  }
  const emit = (ident: number, data: string) =>
    (handlers.get(ident) ?? []).map(callback => callback(data))
  return { registry, handlers, disposed, emit }
}

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

describe('parseProgramStateOsc', () => {
  it('maps the sequences Codex and OpenCode actually emit', () => {
    expect(parseProgramStateOsc('state=working:app=codex')).toBe('working')
    expect(parseProgramStateOsc('state=done:app=codex')).toBe('idle')
    expect(parseProgramStateOsc('state=idle:app=opencode')).toBe('idle')
    expect(parseProgramStateOsc('state=blocked:kind=permission:app=codex')).toBe('idle')
    expect(parseProgramStateOsc('state=clear')).toBe('clear')
    expect(parseProgramStateOsc('state=working:app=opencode:title=TmV3')).toBe('working')
  })

  it('ignores per-session details, queries and unknown states', () => {
    expect(parseProgramStateOsc('state=working:id=ses_1:app=opencode')).toBe(null)
    expect(parseProgramStateOsc('state=clear:id=ses_1')).toBe(null)
    expect(parseProgramStateOsc('?')).toBe(null)
    expect(parseProgramStateOsc('state=paused')).toBe(null)
  })
})

describe('registerTerminalOscHandlers', () => {
  it('routes program state reports and swallows them', () => {
    const { registry, emit } = fakeRegistry()
    const onProgramState = vi.fn()
    registerTerminalOscHandlers(registry, { onProgramState })
    expect(emit(7501, 'state=working:app=codex')).toEqual([true])
    expect(emit(7501, '?')).toEqual([true])
    expect(onProgramState.mock.calls).toEqual([['working']])
  })

  it('routes titles and shell-integration markers and swallows them', () => {
    const { registry, emit } = fakeRegistry()
    const onTitle = vi.fn()
    const onCommandStart = vi.fn()
    const onCommandEnd = vi.fn()
    registerTerminalOscHandlers(registry, { onTitle, onCommandStart, onCommandEnd })

    expect(emit(2, '  🚀 build  ')).toEqual([true])
    expect(emit(0, '   ')).toEqual([true])
    expect(onTitle.mock.calls).toEqual([['build']])

    expect(emit(133, 'C')).toEqual([true])
    expect(emit(633, 'D;0')).toEqual([true])
    expect(emit(133, 'B')).toEqual([true])
    expect(onCommandStart).toHaveBeenCalledTimes(1)
    expect(onCommandEnd).toHaveBeenCalledTimes(1)
  })

  it('swallows OSC codes xterm or addons would otherwise act on', () => {
    const { registry, emit } = fakeRegistry()
    registerTerminalOscHandlers(registry, {})
    for (const ident of SUPPRESSED_OSC_IDENTS) expect(emit(ident, 'x')).toEqual([true])
  })

  it('disposes every registered handler', () => {
    const { registry, handlers, disposed } = fakeRegistry()
    const dispose = registerTerminalOscHandlers(registry, {})
    dispose()
    expect([...disposed].sort((a, b) => a - b)).toEqual([...handlers.keys()].sort((a, b) => a - b))
  })
})
