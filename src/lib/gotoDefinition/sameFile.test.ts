import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { resolveSameFile } from './sameFile'

describe('resolveSameFile', () => {
  it('jumps to a Python def from a call site', () => {
    const doc = `def greet():
  pass

greet()
`
    const state = EditorState.create({ doc, extensions: [python()] })
    const pos = doc.lastIndexOf('greet')
    const targets = resolveSameFile(state, 'greet', pos, '/tmp/a.py')
    expect(targets.length).toBeGreaterThan(0)
    expect(targets[0]?.line).toBe(1)
    expect(targets[0]?.path).toBe('/tmp/a.py')
  })

  it('jumps to a JS function declaration', () => {
    const doc = `function outer() {}
outer()
`
    const state = EditorState.create({ doc, extensions: [javascript()] })
    const pos = doc.lastIndexOf('outer')
    const targets = resolveSameFile(state, 'outer', pos, '/tmp/a.js')
    expect(targets[0]?.line).toBe(1)
  })

  it('finds Python assignment target (logger = …)', () => {
    const doc = `from utils.log_utils import dj_logger

logger = dj_logger
print(logger)
`
    const state = EditorState.create({ doc, extensions: [python()] })
    const usePos = doc.lastIndexOf('logger')
    const targets = resolveSameFile(state, 'logger', usePos, '/proj/a.py')
    expect(targets.length).toBeGreaterThan(0)
    expect(targets[0]?.line).toBe(3)
    expect(targets[0]?.label).toBe('variable')
  })

  it('finds Python import binding for an imported name', () => {
    const doc = `from utils.log_utils import dj_logger

logger = dj_logger
`
    const state = EditorState.create({ doc, extensions: [python()] })
    const usePos = doc.lastIndexOf('dj_logger')
    const targets = resolveSameFile(state, 'dj_logger', usePos, '/proj/a.py')
    expect(targets.length).toBeGreaterThan(0)
    expect(targets[0]?.line).toBe(1)
  })
})
