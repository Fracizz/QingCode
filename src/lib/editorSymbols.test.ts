import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { extractEditorSymbols, editorSymbolKindLabel } from './editorSymbols'

function stateWith(lang: ReturnType<typeof javascript>, doc: string) {
  return EditorState.create({ doc, extensions: [lang] })
}

describe('extractEditorSymbols', () => {
  it('extracts JS functions, classes, and methods', () => {
    const state = stateWith(
      javascript({ typescript: true }),
      `
export function outer() {}
export class Foo {
  bar() {}
}
const arrow = () => 1
`,
    )
    const symbols = extractEditorSymbols(state, 5000)
    const names = symbols.map(s => s.name)
    expect(names).toContain('outer')
    expect(names).toContain('Foo')
    expect(names).toContain('bar')
    expect(names).toContain('arrow')
    expect(symbols.find(s => s.name === 'Foo')?.kind).toBe('class')
    expect(symbols.find(s => s.name === 'bar')?.kind).toBe('method')
    expect(symbols.find(s => s.name === 'outer')?.kind).toBe('function')
    expect(symbols.find(s => s.name === 'arrow')?.kind).toBe('function')
  })

  it('extracts local JavaScript variables and parameters', () => {
    const state = stateWith(
      javascript({ typescript: true }),
      'const value = 1\nfunction run(param) { let inner = param }\n'
    )
    const symbols = extractEditorSymbols(state, 5000)
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'value', kind: 'variable' }),
        expect.objectContaining({ name: 'param', kind: 'variable' }),
        expect.objectContaining({ name: 'inner', kind: 'variable' }),
      ])
    )
  })

  it('extracts Python defs and classes', () => {
    const state = stateWith(
      python(),
      `def foo():
  pass
class Bar:
  def meth(self):
    pass
`,
    )
    const symbols = extractEditorSymbols(state, 5000)
    expect(symbols.map(s => s.name)).toEqual(expect.arrayContaining(['foo', 'Bar', 'meth']))
    expect(symbols.find(s => s.name === 'meth')?.depth).toBeGreaterThan(0)
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'foo', kind: 'function' }),
        expect.objectContaining({ name: 'self', kind: 'variable' }),
      ])
    )
  })

  it('extracts Rust, Go, and Java declarations', () => {
    const rustSymbols = extractEditorSymbols(
      stateWith(
        rust(),
        'const VALUE: i32 = 1; struct Widget {} fn run(arg: i32) { let local = arg; }'
      ),
      5000
    )
    expect(rustSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'VALUE', kind: 'constant' }),
        expect.objectContaining({ name: 'Widget', kind: 'class' }),
        expect.objectContaining({ name: 'run', kind: 'function' }),
        expect.objectContaining({ name: 'local', kind: 'variable' }),
      ])
    )

    const goSymbols = extractEditorSymbols(
      stateWith(go(), 'const Value = 1\nfunc Run(arg int) { local := arg }\ntype Widget struct {}'),
      5000
    )
    expect(goSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Value', kind: 'constant' }),
        expect.objectContaining({ name: 'Run', kind: 'function' }),
        expect.objectContaining({ name: 'Widget', kind: 'class' }),
      ])
    )

    const javaSymbols = extractEditorSymbols(
      stateWith(
        java(),
        'class Widget { static final int VALUE = 1; void run(int arg) { int local = arg; } }'
      ),
      5000
    )
    expect(javaSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Widget', kind: 'class' }),
        expect.objectContaining({ name: 'run', kind: 'method' }),
        expect.objectContaining({ name: 'local', kind: 'variable' }),
      ])
    )
  })

  it('extracts markdown headings', () => {
    const state = stateWith(markdown(), '# Title\n## Sub\n')
    const symbols = extractEditorSymbols(state, 5000)
    expect(symbols.map(s => ({ name: s.name, kind: s.kind, depth: s.depth }))).toEqual([
      { name: 'Title', kind: 'heading', depth: 0 },
      { name: 'Sub', kind: 'heading', depth: 1 },
    ])
  })

  it('extracts CSS selectors', () => {
    const state = stateWith(css(), '.foo { color: red }\n#bar {}\n')
    const symbols = extractEditorSymbols(state, 5000)
    expect(symbols.some(s => s.kind === 'selector' && s.name.includes('.foo'))).toBe(true)
    expect(symbols.some(s => s.kind === 'selector' && s.name.includes('#bar'))).toBe(true)
  })

  it('returns empty for plain text without a language pack', () => {
    const state = EditorState.create({ doc: 'function looksLikeJs() {}\n' })
    expect(extractEditorSymbols(state, 5000)).toEqual([])
  })
})

describe('editorSymbolKindLabel', () => {
  it('returns Chinese source keys', () => {
    expect(editorSymbolKindLabel('function')).toBe('函数')
    expect(editorSymbolKindLabel('heading')).toBe('标题')
  })
})
