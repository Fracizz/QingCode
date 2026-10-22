// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { registerTerminalOscHandlers } from './terminalOsc'

function write(term: Terminal, data: string) {
  return new Promise<void>(resolve => term.write(data, resolve))
}

describe('registerTerminalOscHandlers with xterm', () => {
  it('fires handlers across split chunks and blocks OSC 52 clipboard reads', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const provider = {
      readText: vi.fn(async () => 'secret'),
      writeText: vi.fn(async () => undefined),
    }
    term.loadAddon(new ClipboardAddon(undefined, provider))
    const onTitle = vi.fn()
    const onCommandStart = vi.fn()
    registerTerminalOscHandlers(term.parser, { onTitle, onCommandStart })
    const replies: string[] = []
    term.onData(data => replies.push(data))

    await write(term, 'a\x1b]0;my ')
    await write(term, 'title\x07b\x1b]133;C\x07')
    await write(term, '\x1b]52;c;?\x07\x1b]52;c;aGk=\x07\x1b]11;?\x07')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onTitle.mock.calls).toEqual([['my title']])
    expect(onCommandStart).toHaveBeenCalledTimes(1)
    expect(provider.readText).not.toHaveBeenCalled()
    expect(provider.writeText).not.toHaveBeenCalled()
    expect(replies).toEqual([])
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('ab')
    term.dispose()
  })
})
