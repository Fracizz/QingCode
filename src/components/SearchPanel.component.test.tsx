// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import SearchPanel from './SearchPanel'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import type { ReactElement } from 'react'

// Self-contained react-window stub (vi.mock factories are hoisted above imports,
// so they cannot reference the shared `reactWindowMockFactory` import). This
// mirrors `src/test/mockReactWindow.ts` — keep them in sync.
vi.mock('react-window', () => ({
  List: ({
    rowCount,
    rowComponent: Row,
    rowProps,
  }: {
    rowCount: number
    rowComponent: (props: Record<string, unknown>) => ReactElement | null
    rowProps: Record<string, unknown>
  }) => (
    <div>
      {Array.from({ length: rowCount }, (_, index) => (
        <Row
          key={index}
          index={index}
          style={{}}
          ariaAttributes={{
            'aria-posinset': index + 1,
            'aria-setsize': rowCount,
            role: 'listitem',
          }}
          {...rowProps}
        />
      ))}
    </div>
  ),
  useListRef: () => ({ current: null }),
}))

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  findProjectForPath: vi.fn(),
  loadExcludeSettingsForProject: vi.fn(),
  buildReplacePreview: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: mocks.safeInvoke,
  NotInTauriError: class NotInTauriError extends Error {
    constructor(action: string) {
      super(`Not in Tauri: ${action}`)
      this.name = 'NotInTauriError'
    }
  },
}))

vi.mock('../utils/fileReferences', () => ({
  findProjectForPath: mocks.findProjectForPath,
}))

vi.mock('../lib/excludeSettings', () => ({
  loadExcludeSettingsForProject: mocks.loadExcludeSettingsForProject,
}))

vi.mock('../lib/workspaceReplace', () => ({
  buildReplacePreview: mocks.buildReplacePreview,
}))

const project: Project = {
  id: 'p1',
  name: 'Alpha',
  path: 'D:/alpha',
  created_at: 1,
  last_opened_at: 1,
  hidden: 0,
}

const initialProjectState = useProjectStore.getState()
const initialEditorState = useEditorStore.getState()
const initialUiState = useUIStore.getState()

function dispatch(commands: Record<string, (args: Record<string, unknown> | undefined) => unknown>) {
  mocks.safeInvoke.mockImplementation(async (_action: string, command: string, args?: Record<string, unknown>) => {
    const handler = commands[command]
    return handler ? handler(args) : undefined
  })
}

describe('SearchPanel', () => {
  beforeEach(() => {
    mocks.safeInvoke.mockReset()
    mocks.findProjectForPath.mockReset()
    mocks.loadExcludeSettingsForProject.mockReset()
    mocks.buildReplacePreview.mockReset()
    mocks.findProjectForPath.mockReturnValue(project)
    mocks.loadExcludeSettingsForProject.mockResolvedValue({
      searchExclude: [],
      useIgnoreFiles: false,
      followSymlinks: false,
    })
    dispatch({
      list_file_extensions: () => ['ts', 'tsx'],
      search_files: () => [
        { name: 'app.tsx', path: 'D:/alpha/src/app.tsx', relative: 'src/app.tsx', is_dir: false },
      ],
      start_content_search: () => 1,
      cancel_content_search: () => undefined,
    })
    useProjectStore.setState({
      projects: [project],
      currentProject: project,
      unavailableProjectIds: [],
      toasts: [],
      openFile: vi.fn().mockResolvedValue(undefined),
    })
    useEditorStore.setState({ openFile: vi.fn().mockResolvedValue(undefined) })
    useUIStore.setState({ searchRoot: null, setSearchRoot: vi.fn(), globalSearchSignal: 0 })
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useEditorStore.setState(initialEditorState, true)
    useUIStore.setState(initialUiState, true)
  })

  it('scans project extensions on mount', async () => {
    render(<SearchPanel />)
    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('扫描项目扩展名', 'list_file_extensions', {
        roots: ['D:/alpha'],
        maxFiles: 8000,
      })
    )
  })

  it('runs a filename search after typing a query and renders the hit', async () => {
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('搜索文件或内容…')
    fireEvent.change(input, { target: { value: 'app' } })

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('文件搜索', 'search_files', expect.objectContaining({ root: 'D:/alpha', query: 'app' }))
    )
    // The filename section header and the hit's base name both render.
    await waitFor(() => expect(screen.getByText('文件名匹配')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('app.tsx')).toBeInTheDocument())
  })

  it('shows an empty-state prompt when no project is selected', () => {
    useProjectStore.setState({ projects: [], currentProject: null, unavailableProjectIds: [] })
    render(<SearchPanel />)
    expect(screen.getByText('请先选择或添加项目')).toBeInTheDocument()
  })
})
