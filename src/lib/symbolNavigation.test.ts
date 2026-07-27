// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab, Project } from '../types'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { registerEditorView, unregisterEditorView } from './editorSession'
import { findUsagesAfterDefinitionJump } from './symbolNavigation'

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
let view: EditorView | null = null

beforeEach(() => {
  mocks.findSemanticUsages.mockReset()
  mocks.findSemanticUsagesById.mockReset()
  mocks.searchIndexedWorkspaceSymbols.mockReset()
  mocks.safeInvoke.mockReset()
  useDefinitionPickerStore.getState().closePicker()
})

afterEach(() => {
  if (view) {
    unregisterEditorView('definition-tab', view)
    view.destroy()
    view = null
  }
  document.body.replaceChildren()
  useEditorStore.setState(initialEditorState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('findUsagesAfterDefinitionJump', () => {
  it('uses the final definition binding after Ctrl+click reaches the source', async () => {
    const sourceState = EditorState.create({ doc: 'target()' })
    const definition = {
      symbolId: 'function:target',
      name: 'target',
      kind: 'function',
      path: 'D:/alpha/definition.ts',
      relative: 'definition.ts',
      line: 1,
      column: 10,
      text: 'function target() {}',
      score: 2400,
    }
    const usage = {
      ...definition,
      path: 'D:/alpha/caller.ts',
      relative: 'caller.ts',
      line: 4,
      column: 3,
      text: 'target()',
      usageKind: 'call',
    }
    mocks.findSemanticUsagesById.mockResolvedValue({
      symbolId: 'function:target',
      name: 'target',
      kind: 'function',
      definition,
      usages: [usage],
      totalCount: 1,
      filesIndexed: 2,
      complete: true,
      truncated: false,
    })
    useProjectStore.setState({
      projects: [project],
      currentProject: project,
      unavailableProjectIds: [],
    })
    const tab = {
      id: 'definition-tab',
      path: definition.path,
      name: 'definition.ts',
      language: 'typescript',
      dirty: false,
      content: definition.text,
    } as EditorTab
    useEditorStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      pendingReveal: null,
    })
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({
      parent,
      state: EditorState.create({ doc: definition.text }),
    })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue(null)
    registerEditorView(tab.id, view)

    await findUsagesAfterDefinitionJump(definition, {
      path: 'D:/alpha/caller.ts',
      state: sourceState,
      position: 0,
    })

    expect(mocks.findSemanticUsagesById).toHaveBeenCalledWith(
      project.path,
      'function:target',
      undefined
    )
    expect(mocks.findSemanticUsages).not.toHaveBeenCalled()
    expect(useDefinitionPickerStore.getState()).toMatchObject({
      open: true,
      mode: 'reference',
      symbol: 'target',
      candidates: [expect.objectContaining({ relative: 'caller.ts' })],
    })
  })
})
