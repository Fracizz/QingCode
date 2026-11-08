import { describe, expect, it } from 'vitest'
import {
  findTerminalFileLinks,
  parseTerminalHyperlink,
  terminalBufferFileLinks,
  terminalFileCandidates,
  type TerminalBufferLike,
} from './terminalFileLinks'

const found = (text: string) =>
  findTerminalFileLinks(text).map(({ path, line, column }) => ({ path, line, column }))
const paths = (text: string) => findTerminalFileLinks(text).map(link => link.path)

describe('findTerminalFileLinks', () => {
  it.each([
    ['src/a.ts:12:3', 'src/a.ts', 12, 3],
    ['src/a.ts:12', 'src/a.ts', 12, undefined],
    ['src/a.ts:12-20', 'src/a.ts', 12, undefined],
    ['src/a.ts#L12-L20', 'src/a.ts', 12, undefined],
    ['Foo.cs(12,3): error', 'Foo.cs', 12, 3],
    ['Foo.cs(12): error', 'Foo.cs', 12, undefined],
    ['File "tools/run.py", line 44, in main', 'tools/run.py', 44, undefined],
    ['at x.y.Foo(Foo.java:12)', 'Foo.java', 12, undefined],
    ['D:\\code\\app\\a.ts:7', 'D:\\code\\app\\a.ts', 7, undefined],
    ['/home/me/app/a.py:9:2', '/home/me/app/a.py', 9, 2],
    ['./scripts/run.sh', './scripts/run.sh', undefined, undefined],
    ['../lib/x.rs:1', '../lib/x.rs', 1, undefined],
    ['src/组件/页面.tsx:3', 'src/组件/页面.tsx', 3, undefined],
    ['app/[id]/(group)/page.tsx', 'app/[id]/(group)/page.tsx', undefined, undefined],
    ['read @src/a.ts#L5', 'src/a.ts', 5, undefined],
    ['+++ b/src/a.ts', 'b/src/a.ts', undefined, undefined],
  ])('recognizes %s', (text, path, line, column) => {
    expect(found(text)).toEqual([{ path, line, column }])
  })

  it('finds bare file names only when they look like source files', () => {
    expect(paths('edit package.json and README.md')).toEqual(['package.json', 'README.md'])
    expect(paths('see Makefile')).toEqual(['Makefile'])
    expect(paths('foo.unknown:12')).toEqual(['foo.unknown'])
  })

  it.each([
    'and/or TCP/IP w/o',
    'console.log("x")',
    'Node.js and Vue.js',
    'version 1.2.3 and 3.14',
    'src/components/',
    '/api/users',
    'localhost:8080 example.com:8080 127.0.0.1:80',
    'docker/image:12',
    '12:30:45',
  ])('does not link %s', text => {
    expect(paths(text)).toEqual([])
  })

  it('does not treat URLs as paths', () => {
    expect(paths('open https://x.dev/docs/a.ts:1 now')).toEqual([])
  })

  it('strips surrounding punctuation', () => {
    expect(paths('(src/a.ts), [src/b.ts]; src/c.ts.')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(found('`src/a.ts:12`')).toEqual([{ path: 'src/a.ts', line: 12, column: undefined }])
  })

  it('reads quoted paths with spaces but not quoted sentences', () => {
    expect(found('"C:\\Program Files\\app\\a.ts":12')).toEqual([
      { path: 'C:\\Program Files\\app\\a.ts', line: 12, column: undefined },
    ])
    expect(found('File "/my dir/a.py", line 3')).toEqual([
      { path: '/my dir/a.py', line: 3, column: undefined },
    ])
    expect(paths('"see docs/a.md for details"')).toEqual(['docs/a.md'])
  })

  it('reports the range including the location suffix', () => {
    const text = 'x src/a.ts:12 y'
    const [link] = findTerminalFileLinks(text)
    expect(text.slice(link!.start, link!.end)).toBe('src/a.ts:12')
  })

  it('skips pathologically long lines', () => {
    expect(paths(`${'a'.repeat(9000)} src/a.ts`)).toEqual([])
  })
})

describe('parseTerminalHyperlink', () => {
  it('keeps web links', () => {
    expect(parseTerminalHyperlink('https://a.dev/x')).toEqual({ kind: 'web', url: 'https://a.dev/x' })
  })

  it.each([
    ['file:///D:/code/a%20b.ts', { path: 'D:/code/a b.ts' }],
    ['file://remote-host/srv/app/a.ts', { path: '/srv/app/a.ts' }],
    ['file:///srv/a.ts#L12', { path: '/srv/a.ts', line: 12 }],
    ['vscode://file/D:/code/a.ts:12:3', { path: 'D:/code/a.ts', line: 12, column: 3 }],
    ['cursor://file/srv/a.ts:4', { path: '/srv/a.ts', line: 4 }],
  ])('parses %s', (uri, target) => {
    expect(parseTerminalHyperlink(uri)).toEqual({ kind: 'file', ...target })
  })

  it.each(['javascript:alert(1)', 'vscode://extension/foo', 'ms-settings:privacy', 'not a url'])(
    'rejects %s',
    uri => {
      expect(parseTerminalHyperlink(uri)).toBeNull()
    },
  )
})

describe('terminalFileCandidates', () => {
  it('tries the terminal directory before the project root on Windows', () => {
    expect(
      terminalFileCandidates('lib/b.ts', { root: 'D:\\code\\app', cwd: 'D:\\code\\app\\pkg' }),
    ).toEqual(['D:\\code\\app\\pkg\\lib\\b.ts', 'D:\\code\\app\\lib\\b.ts'])
  })

  it('rewrites paths under the root to the project spelling', () => {
    expect(terminalFileCandidates('d:/CODE/app/x.ts', { root: 'D:\\code\\app' })).toEqual([
      'D:\\code\\app\\x.ts',
    ])
  })

  it('offers variants without git diff and project name prefixes', () => {
    expect(terminalFileCandidates('b/src/a.ts', { root: '/w' })).toEqual(['/w/b/src/a.ts', '/w/src/a.ts'])
    expect(terminalFileCandidates('app/src/a.ts', { root: '/w', projectName: 'app' })).toEqual([
      '/w/app/src/a.ts',
      '/w/src/a.ts',
    ])
  })

  it('does not map POSIX paths onto a local Windows project', () => {
    expect(terminalFileCandidates('/usr/lib/a.py', { root: 'D:\\code\\app' })).toEqual([])
  })

  it('does not map Windows paths onto a local POSIX project', () => {
    expect(terminalFileCandidates('D:\\code\\a.ts', { root: '/w' })).toEqual([])
  })

  it('maps POSIX absolute paths into the WSL distribution', () => {
    expect(
      terminalFileCandidates('/home/me/a.ts', { root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app' }),
    ).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts'])
    expect(
      terminalFileCandidates('D:\\a.ts', { root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app' }),
    ).toEqual([])
  })

  it('keeps SSH results as resources inside the project root', () => {
    const root = 'ssh://conn/srv/app'
    expect(terminalFileCandidates('/srv/app/a.ts', { root })).toEqual(['ssh://conn/srv/app/a.ts'])
    expect(terminalFileCandidates('src/a.ts', { root, cwd: root })).toEqual(['ssh://conn/srv/app/src/a.ts'])
  })

  it.each(['/etc/passwd', '/srv/app/../secret.txt', '../secret.txt', '/srv/application/a.ts'])(
    'rejects SSH path outside the root: %s',
    path => {
      expect(terminalFileCandidates(path, { root: 'ssh://conn/srv/app' })).toEqual([])
    },
  )

  it('supports Windows OpenSSH roots', () => {
    expect(terminalFileCandidates('D:\\code\\app\\a.ts', { root: 'ssh://conn/D:/code/app' })).toEqual([
      'ssh://conn/D:/code/app/a.ts',
    ])
  })
})

describe('terminalBufferFileLinks', () => {
  function buffer(rows: string[], wrapped: boolean[] = []): TerminalBufferLike {
    return {
      getLine: y => {
        const row = rows[y]
        if (row === undefined) return undefined
        const cells = [...row].flatMap(char =>
          /[\u4e00-\u9fff]/.test(char)
            ? [{ chars: char, width: 2 }, { chars: '', width: 0 }]
            : [{ chars: char, width: 1 }],
        )
        return {
          isWrapped: wrapped[y] === true,
          length: cells.length,
          getCell: x => {
            const cell = cells[x]
            return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined
          },
        }
      },
    }
  }

  it('maps ranges to 1-based inclusive cells after wide characters', () => {
    expect(terminalBufferFileLinks(buffer(['中文 src/a.ts:2']), 0)).toEqual([
      {
        target: { path: 'src/a.ts', line: 2 },
        range: { start: { x: 6, y: 1 }, end: { x: 15, y: 1 } },
      },
    ])
  })

  it('joins soft-wrapped rows into one link', () => {
    const rows = buffer(['x src/lo', 'ng/a.ts:7'], [false, true])
    const expected = [
      {
        target: { path: 'src/long/a.ts', line: 7 },
        range: { start: { x: 3, y: 1 }, end: { x: 9, y: 2 } },
      },
    ]
    expect(terminalBufferFileLinks(rows, 0)).toEqual(expected)
    expect(terminalBufferFileLinks(rows, 1)).toEqual(expected)
  })
})
