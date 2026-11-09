import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '@/types'
import {
  assertCliTerminalWritable,
  cliTerminalSummary,
  latestRunTerminals,
  readCliTerminal,
  resolveCliTerminal,
  tailTerminalText,
} from './cliTerminal'
import { plainTerminalText, registerTerminalReader } from './terminalContent'

function tab(partial: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    name: partial.id,
    projectId: 'p1',
    cwd: '/srv/app',
    launchCommand: '',
    status: 'running',
    exitCode: null,
    ...partial,
  } as TerminalTab
}

describe('resolveCliTerminal', () => {
  const terminals = [
    tab({ id: 'a', name: 'shell' }),
    tab({ id: 'b', name: 'dup' }),
    tab({ id: 'c', name: 'dup' }),
    tab({ id: 'other', name: 'remote', projectId: 'p2' }),
    tab({ id: 'd', name: 'remote' }),
  ]

  it('prefers the id, then a unique name', () => {
    expect(resolveCliTerminal(terminals, 'p1', 'a').id).toBe('a')
    expect(resolveCliTerminal(terminals, 'p1', ' shell ').id).toBe('a')
  })

  it('never resolves a terminal owned by another project', () => {
    expect(() => resolveCliTerminal(terminals, 'p1', 'other')).toThrow('terminal not found')
    expect(resolveCliTerminal(terminals, 'p1', 'remote').id).toBe('d')
  })

  it('rejects ambiguous names', () => {
    expect(() => resolveCliTerminal(terminals, 'p1', 'dup')).toThrow('ambiguous')
    expect(resolveCliTerminal(terminals, 'p1', 'b').id).toBe('b')
  })
})

describe('assertCliTerminalWritable', () => {
  it('accepts only a fully started running terminal', () => {
    expect(() => assertCliTerminalWritable(tab({ id: 'a' }))).not.toThrow()
    for (const status of ['starting', 'reconnecting', 'exited'] as const) {
      expect(() => assertCliTerminalWritable(tab({ id: 'a', status }))).toThrow(status)
    }
    expect(() => assertCliTerminalWritable(tab({ id: 'a', ptySpawnPending: true }))).toThrow(
      'starting'
    )
  })
})

describe('cliTerminalSummary', () => {
  it('reports writability and omits launch command and env', () => {
    const summary = cliTerminalSummary(
      tab({ id: 'a', launchCommand: 'TOKEN=1 run', env: { SECRET: 'x' }, status: 'exited' })
    )
    expect(summary).toMatchObject({ id: 'a', status: 'exited', writable: false })
    expect(JSON.stringify(summary)).not.toMatch(/TOKEN|SECRET/)
  })
})

describe('plainTerminalText', () => {
  it('removes CSI, OSC and charset sequences', () => {
    expect(plainTerminalText('\x1b]0;title\x07\x1b(B\x1b[1;32mok\x1b[0m')).toBe('ok')
    expect(plainTerminalText('\x1b]2;t\x1b\\a')).toBe('a')
  })

  it('keeps the last overwrite of a carriage-returned line', () => {
    expect(plainTerminalText('10%\r50%\r100%\r\nnext\r\n')).toBe('100%\nnext')
  })
})

describe('latestRunTerminals', () => {
  const run = (runTaskId: string, status: TerminalTab['status'], createdAt: number) =>
    ({ runTaskId, status, createdAt }) as TerminalTab

  it('keeps one terminal per task, newest first among exited ones', () => {
    const newest = run('a', 'exited', 2)
    expect(latestRunTerminals([run('a', 'exited', 1), newest])).toEqual([newest])
  })

  it('prefers a live terminal over a newer exited one', () => {
    const alive = run('a', 'running', 1)
    expect(latestRunTerminals([alive, run('a', 'exited', 2)])).toEqual([alive])
  })

  it('keeps separate tasks', () => {
    expect(latestRunTerminals([run('a', 'running', 1), run('b', 'running', 1)])).toHaveLength(2)
  })
})

describe('tailTerminalText', () => {
  it('keeps only the requested trailing lines', () => {
    expect(tailTerminalText('a\nb\nc', 2)).toEqual({
      text: 'b\nc',
      lines: 2,
      totalLines: 3,
      truncated: true,
    })
  })

  it('does not report truncation when everything fits', () => {
    expect(tailTerminalText('a\nb', 5)).toEqual({
      text: 'a\nb',
      lines: 2,
      totalLines: 2,
      truncated: false,
    })
  })

  it('treats empty output as zero lines', () => {
    expect(tailTerminalText('')).toEqual({ text: '', lines: 0, totalLines: 0, truncated: false })
  })

  it('drops the partial first line when the size cap applies', () => {
    const long = `${'x'.repeat(1_000_100)}\nlast`
    const result = tailTerminalText(long, 10)
    expect(result.text).toBe('last')
    expect(result.truncated).toBe(true)
  })
})

describe('readCliTerminal', () => {
  let unregister: (() => void) | undefined
  afterEach(() => unregister?.())

  it('reports unavailable output instead of an empty success', async () => {
    await expect(readCliTerminal('missing', 'buffer')).resolves.toMatchObject({
      available: false,
      text: '',
    })
  })

  it('passes the scope to the registered reader and applies the tail', async () => {
    const scopes: string[] = []
    unregister = registerTerminalReader('t1', async scope => {
      scopes.push(scope)
      return 'a\nb\nc'
    })
    await expect(readCliTerminal('t1', 'screen', 1)).resolves.toMatchObject({
      available: true,
      text: 'c',
    })
    expect(scopes).toEqual(['screen'])
  })

  it('falls back to approximate text when no xterm instance exists', async () => {
    await expect(
      readCliTerminal('missing', 'buffer', 5, () => '\x1b[32mready\x1b[0m\r\n')
    ).resolves.toMatchObject({ available: true, approximate: true, text: 'ready' })
  })

  it('prefers the xterm buffer over the raw fallback', async () => {
    unregister = registerTerminalReader('t3', async () => 'parsed')
    await expect(readCliTerminal('t3', 'buffer', 5, () => 'raw')).resolves.toMatchObject({
      approximate: false,
      text: 'parsed',
    })
  })

  it('stops reading after the terminal is unregistered', async () => {
    unregister = registerTerminalReader('t2', async () => 'x')
    unregister()
    await expect(readCliTerminal('t2', 'buffer')).resolves.toMatchObject({ available: false })
  })
})
