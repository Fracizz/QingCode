import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { identifierAt } from './tokenAt'

describe('identifierAt', () => {
  it('finds a Python function name', () => {
    const doc = 'def greet(name):\n  return name\n'
    const state = EditorState.create({ doc, extensions: [python()] })
    const pos = doc.indexOf('greet') + 2
    expect(identifierAt(state, pos)?.name).toBe('greet')
  })

  it('finds a JS identifier via word fallback when needed', () => {
    const doc = 'const value = 1\nconsole.log(value)\n'
    const state = EditorState.create({ doc, extensions: [javascript()] })
    const pos = doc.lastIndexOf('value') + 1
    expect(identifierAt(state, pos)?.name).toBe('value')
  })
})
