import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  definitionContextAt,
  identifierAt,
  rankDefinitionCandidates,
  relativeImportTarget,
  type DefinitionCandidate,
} from './definitionNavigation'

function candidate(
  path: string,
  kind: string,
  score = 0
): DefinitionCandidate {
  return {
    name: 'Widget',
    kind,
    path,
    relative: path.replace('D:/work/', ''),
    line: 1,
    column: 1,
    text: '',
    score,
  }
}

describe('identifierAt', () => {
  it('extracts the language word under and at the end of a name', () => {
    const state = EditorState.create({ doc: 'const value = target()' })
    const start = state.doc.toString().indexOf('target')
    expect(identifierAt(state, start + 2)?.name).toBe('target')
    expect(identifierAt(state, start + 'target'.length)?.name).toBe('target')
  })

  it('rejects keywords and punctuation', () => {
    const state = EditorState.create({ doc: 'return value + 1' })
    expect(identifierAt(state, 2)).toBeNull()
    expect(identifierAt(state, 13)).toBeNull()
  })
})

describe('definitionContextAt', () => {
  it('recognizes constructor and call contexts', () => {
    const constructor = EditorState.create({ doc: 'new Widget()' })
    const widget = identifierAt(constructor, 5)!
    expect(definitionContextAt(constructor, widget)).toBe('class')

    const call = EditorState.create({ doc: 'runTask()' })
    const runTask = identifierAt(call, 2)!
    expect(definitionContextAt(call, runTask)).toBe('call')
  })
})

describe('rankDefinitionCandidates', () => {
  it('prefers same-file and context-compatible definitions', () => {
    const ranked = rankDefinitionCandidates(
      [
        candidate('D:/work/src/other.ts', 'function'),
        candidate('D:/work/src/current.ts', 'class'),
        candidate('D:/work/tests/current.ts', 'class', 20),
      ],
      'D:/work/src/current.ts',
      'class'
    )
    expect(ranked[0].path).toBe('D:/work/src/current.ts')
    expect(ranked[1].path).toBe('D:/work/tests/current.ts')
  })

  it('boosts the file named by a relative TypeScript import', () => {
    const state = EditorState.create({
      doc: "import { Widget } from '../models/widget'\nnew Widget()",
    })
    const target = relativeImportTarget(
      state,
      'D:/work/src/views/current.ts',
      'Widget'
    )
    expect(target).toBe('d:/work/src/models/widget')

    const ranked = rankDefinitionCandidates(
      [
        candidate('D:/work/src/other/Widget.ts', 'class', 100),
        candidate('D:/work/src/models/widget.ts', 'class'),
      ],
      'D:/work/src/views/current.ts',
      'class',
      target
    )
    expect(ranked[0].path).toBe('D:/work/src/models/widget.ts')
  })
})
