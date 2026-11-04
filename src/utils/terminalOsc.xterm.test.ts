// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { MAX_OSC_CLIPBOARD_BYTES, registerTerminalOscHandlers } from './terminalOsc'

function write(term: Terminal, data: string) {
  return new Promise<void>(resolve => term.write(data, resolve))
}

describe('registerTerminalOscHandlers with xterm', () => {
  it('copies UTF-8 text across split chunks without allowing addon clipboard reads', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const provider = {
      readText: vi.fn(async () => 'secret'),
      writeText: vi.fn(async () => undefined),
    }
    term.loadAddon(new ClipboardAddon(undefined, provider))
    const onTitle = vi.fn()
    const onCommandStart = vi.fn()
    const onClipboardWrite = vi.fn()
    registerTerminalOscHandlers(term.parser, { onTitle, onCommandStart, onClipboardWrite })
    const replies: string[] = []
    term.onData(data => replies.push(data))

    await write(term, 'a\x1b]0;my ')
    await write(term, 'title\x07b\x1b]133;C\x07')
    await write(term, '\x1b]52;c;?\x07\x1b]52;c;aGk=\x07\x1b]11;?\x07')
    const unicode = btoa(String.fromCharCode(...new TextEncoder().encode('你好 OpenCode 👋')))
    await write(term, `\x1b]52;;${unicode.slice(0, 5)}`)
    await write(term, `${unicode.slice(5)}\x1b\\`)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onTitle.mock.calls).toEqual([['my title']])
    expect(onCommandStart).toHaveBeenCalledTimes(1)
    expect(provider.readText).not.toHaveBeenCalled()
    expect(provider.writeText).not.toHaveBeenCalled()
    expect(onClipboardWrite.mock.calls).toEqual([['hi'], ['你好 OpenCode 👋']])
    expect(replies).toEqual([])
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('ab')
    term.dispose()
  })

  it('ignores unsupported selections, malformed UTF-8/base64 and oversized writes without clearing', async () => {
    const term = new Terminal()
    const onClipboardWrite = vi.fn()
    registerTerminalOscHandlers(term.parser, { onClipboardWrite })
    for (const body of ['c;?', 'p;aGk=', 'c;%%%', 'c;a', 'c;/w==', 'missing-separator']) {
      await write(term, `\x1b]52;${body}\x07`)
    }
    await write(term, `\x1b]52;c;${btoa('x'.repeat(MAX_OSC_CLIPBOARD_BYTES + 1))}\x07`)
    expect(onClipboardWrite).not.toHaveBeenCalled()
    await write(term, '\x1b]52;s;aGk=\x07\x1b]52;c;\x07')
    expect(onClipboardWrite.mock.calls).toEqual([['hi'], ['']])
    term.dispose()
  })
})
