// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { findUsagesAtEditor } from './symbolNavigation'

const mocks = vi.hoisted(() => ({
  findSemanticUsages: vi.fn(),
  findSemanticUsagesById: vi.fn(),
  searchIndexedWorkspaceSymbols: vi.fn(),
  safeInvoke: vi.fn(),
}))

vi.mock('./semanticNavigation', () => ({
  findSemanticUsages: mocks.findSemanticUsages,
  findSemanticUsagesById: mocks.findSemanticUsagesById,
  searchIndexedWorkspaceSymbols: mocks.searchIndexedWorkspaceSymbols,
}))

vi.mock('./tauri', () => ({
  isTauri: () => true,
  safeInvoke: mocks.safeInvoke,
}))

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  path: 'D:/alpha',
  created_at: 1,
  last_opened_at: 1,
  hidden: 0,
}

const initialEditorState = useEditorStore.getState()
const initialProjectState = useProjectStore.getState()

beforeEach(() => {
  mocks.findSemanticUsages.mockReset()
  mocks.findSemanticUsagesById.mockReset()
  mocks.searchIndexedWorkspaceSymbols.mockReset()
  mocks.safeInvoke.mockReset()
  useDefinitionPickerStore.getState().closePicker()
})

afterEach(() => {
  document.body.replaceChildren()
  useEditorStore.setState(initialEditorState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('findUsagesAtEditor', () => {
  it('does not reopen a pending usage popup after the user closes it', async () => {
    let resolveUsages!: (value: {
      symbolId: string
      name: string
      kind: string
      definition: null
      usages: []
      totalCount: number
      filesIndexed: number
      complete: boolean
      truncated: boolean
    }) => void
    mocks.findSemanticUsagesById.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveUsages = resolve
        })
    )
    useProjectStore.setState({
      projects: [project],
      currentProject: project,
      unavailableProjectIds: [],
    })

    const pending = findUsagesAtEditor(
      'D:/alpha/definition.ts',
      EditorState.create({ doc: 'target' }),
      0,
      { left: 10, top: 20, right: 30, bottom: 40 },
      {
        symbolId: 'function:target',
        name: 'target',
        kind: 'function',
      }
    )

    expect(useDefinitionPickerStore.getState().details).toMatchObject({ loading: true })
    useDefinitionPickerStore.getState().closePicker()
    resolveUsages({
      symbolId: 'function:target',
      name: 'target',
      kind: 'function',
      definition: null,
      usages: [],
      totalCount: 0,
      filesIndexed: 1,
      complete: true,
      truncated: false,
    })
    await pending

    expect(useDefinitionPickerStore.getState().open).toBe(false)
  })
})
