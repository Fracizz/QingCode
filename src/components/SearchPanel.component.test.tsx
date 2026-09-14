// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import SearchPanel from './SearchPanel'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { useFavoriteStore } from '../store/favoriteStore'
import type { ReactElement } from 'react'

// Self-contained react-window stub (vi.mock factories are hoisted above imports,
// so they cannot reference the shared `reactWindowMockFactory` import). This
// mirrors `src/test/mockReactWindow.ts` — keep them in sync.
vi.mock('react-window', async () => {
  const React = await import('react')
  const listApi = {
    element: { scrollHeight: 1, clientHeight: 100 },
  }
  return {
    List: ({
      rowCount,
      rowComponent: Row,
      rowProps,
      onRowsRendered,
    }: {
      rowCount: number
      rowComponent: (props: Record<string, unknown>) => ReactElement | null
      rowProps: Record<string, unknown>
      onRowsRendered?: (
        visible: { startIndex: number; stopIndex: number },
        all: { startIndex: number; stopIndex: number },
      ) => void
    }) => {
      React.useEffect(() => {
        if (rowCount <= 0) return
        const range = { startIndex: 0, stopIndex: rowCount - 1 }
        onRowsRendered?.(range, range)
      }, [rowCount, onRowsRendered])
      return (
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
      )
    },
    useListRef: () => ({ current: listApi }),
  }
})

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}))

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  openDirectory: vi.fn(),
  findProjectForPath: vi.fn(),
  loadExcludeSettingsForProject: vi.fn(),
  buildReplacePreview: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDirectory,
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
const initialFavoriteState = useFavoriteStore.getState()

function dispatch(commands: Record<string, (args: Record<string, unknown> | undefined) => unknown>) {
  mocks.safeInvoke.mockImplementation(async (_action: string, command: string, args?: Record<string, unknown>) => {
    const handler = commands[command]
    return handler ? handler(args) : undefined
  })
}

describe('SearchPanel', () => {
  beforeEach(() => {
    mocks.safeInvoke.mockReset()
    mocks.openDirectory.mockReset()
    mocks.openDirectory.mockResolvedValue(null)
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
    useUIStore.setState({
      searchRoot: null,
      setSearchRoot: vi.fn(),
      globalSearchSignal: 0,
      globalSearchQuery: null,
    })
    useFavoriteStore.setState(initialFavoriteState, true)
  })

  afterEach(() => {
    useProjectStore.setState(initialProjectState, true)
    useEditorStore.setState(initialEditorState, true)
    useUIStore.setState(initialUiState, true)
    useFavoriteStore.setState(initialFavoriteState, true)
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

  it('selects an opened-project directory as the search root', async () => {
    mocks.openDirectory.mockResolvedValue('D:/alpha/src')
    render(<SearchPanel />)

    fireEvent.click(screen.getByRole('button', { name: '搜索范围' }))
    fireEvent.click(screen.getByRole('option', { name: '选择目录…' }))

    await waitFor(() =>
      expect(mocks.openDirectory).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        defaultPath: 'D:/alpha',
      }),
    )
    expect(useUIStore.getState().setSearchRoot).toHaveBeenCalledWith('D:/alpha/src')
  })

  it('does not clear a directory search root when handling the focus signal', async () => {
    const setSearchRoot = vi.fn()
    useUIStore.setState({
      searchRoot: 'D:/alpha/src',
      setSearchRoot,
      globalSearchSignal: 3,
      globalSearchQuery: null,
    })

    render(<SearchPanel />)

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('扫描项目扩展名', 'list_file_extensions', {
        roots: ['D:/alpha/src'],
        maxFiles: 8000,
      }),
    )
    expect(setSearchRoot).not.toHaveBeenCalledWith(null)
    expect(screen.getByText('目录：src')).toBeInTheDocument()
  })

  it('accepts a custom file type from the type picker', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    fireEvent.click(screen.getByRole('button', { name: '全部类型' }))

    const customTypeInput = screen.getByRole('textbox', { name: '自定义文件类型' })
    fireEvent.change(customTypeInput, { target: { value: ' .Vue ' } })
    fireEvent.keyDown(customTypeInput, { key: 'Enter' })

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ query: '', extensions: ['vue'] }),
      ),
    )
    expect(screen.getByRole('button', { name: '.vue' })).toBeInTheDocument()
  })

  it('keeps filename mode live after typing a query and renders the hit', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    const input = screen.getByPlaceholderText('搜索文件名，支持 * 通配符…')
    fireEvent.change(input, { target: { value: 'app' } })

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith('文件搜索', 'search_files', expect.objectContaining({ root: 'D:/alpha', query: 'app' }))
    )
    await waitFor(() => expect(screen.getByText('app.tsx')).toBeInTheDocument())
  })

  it('filters filename hits to directories only', async () => {
    dispatch({
      list_file_extensions: () => ['ts'],
      search_files: () => [
        { name: 'services', path: 'D:/alpha/services', relative: 'services', is_dir: true },
        { name: 'app.tsx', path: 'D:/alpha/src/app.tsx', relative: 'src/app.tsx', is_dir: false },
      ],
      start_content_search: () => 1,
      search_file_contents: () => ({
        files: [],
        match_count: 0,
        files_scanned: 0,
        truncated: false,
      }),
      cancel_content_search: () => undefined,
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件名，支持 * 通配符…'), {
      target: { value: 'app' },
    })
    await waitFor(() => expect(screen.getByText('app.tsx')).toBeInTheDocument())

    const entryKindTabs = screen.getByLabelText('按目录或文件筛选')
    fireEvent.click(within(entryKindTabs).getByRole('tab', { name: '目录' }))

    await waitFor(() => expect(screen.getAllByText('services').length).toBeGreaterThan(0))
    expect(screen.queryByText('app.tsx')).not.toBeInTheDocument()
  })

  it('shows copy actions on a filename hit context menu', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件名，支持 * 通配符…'), { target: { value: 'app' } })
    await waitFor(() => expect(screen.getByText('app.tsx')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('app.tsx'))

    expect(await screen.findByText('复制路径')).toBeInTheDocument()
    expect(screen.getByText('复制相对路径')).toBeInTheDocument()
    expect(screen.getByText('复制文件名')).toBeInTheDocument()
  })

  it('shows favorite actions on a search hit context menu', async () => {
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件名，支持 * 通配符…'), { target: { value: 'app' } })
    await waitFor(() => expect(screen.getByText('app.tsx')).toBeInTheDocument())

    fireEvent.contextMenu(screen.getByText('app.tsx'))

    expect(await screen.findByText('收藏文件')).toBeInTheDocument()
  })

  it('raises the filename search budget only after requesting more results', async () => {
    dispatch({
      list_file_extensions: () => ['ts'],
      search_files: (args) => {
        const limit = Number(args?.limit ?? 200)
        return Array.from({ length: limit }, (_, index) => ({
          name: `file-${index}.ts`,
          path: `D:/alpha/file-${index}.ts`,
          relative: `src/file-${index}.ts`,
          is_dir: false,
        }))
      },
      start_content_search: () => 1,
      search_file_contents: () => ({
        files: [],
        match_count: 0,
        files_scanned: 0,
        truncated: false,
      }),
      cancel_content_search: () => undefined,
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件名，支持 * 通配符…'), {
      target: { value: 'file' },
    })

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ limit: 200 }),
      ),
    )
    expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
      '文件搜索',
      'search_files',
      expect.objectContaining({ limit: 500 }),
    )

    fireEvent.click(await screen.findByRole('button', { name: '显示更多结果' }))

    await waitFor(
      () =>
        expect(mocks.safeInvoke).toHaveBeenCalledWith(
          '文件搜索',
          'search_files',
          expect.objectContaining({ limit: 500 }),
        ),
      { timeout: 3000 },
    )
  })

  it('retains successful filename and content hits when another project fails, then retries', async () => {
    const beta: Project = { ...project, id: 'p2', name: 'Beta', path: 'D:/beta' }
    useProjectStore.setState({ projects: [project, beta] })
    mocks.findProjectForPath.mockImplementation((_projects, path) => String(path).startsWith(beta.path) ? beta : project)
    let betaUnavailable = true
    const rootName = (args?: Record<string, unknown>) => {
      const name = args?.root === beta.path ? 'beta' : 'alpha'
      if (name === 'beta' && betaUnavailable) throw new Error('connection unavailable')
      return name
    }
    dispatch({
      list_file_extensions: () => ['ts'],
      search_files: args => {
        const name = rootName(args)
        return [{ name: `good-${name}.ts`, path: `D:/${name}/src/good-${name}.ts`, relative: `src/good-${name}.ts`, is_dir: false }]
      },
      start_content_search: () => 1,
      cancel_content_search: () => undefined,
      search_file_contents: args => {
        const name = rootName(args)
        return {
          files: [{
            name: `content-${name}.ts`, path: `D:/${name}/src/content-${name}.ts`, relative: `src/content-${name}.ts`,
            matches: [{ line: 1, text: 'needle retained', match_start: 0, match_end: 6 }],
          }],
          match_count: 1, files_scanned: 1, truncated: false,
        }
      },
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('button', { name: '搜索范围' }))
    fireEvent.click(screen.getByRole('option', { name: '全部项目' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件或内容…'), { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    expect(await screen.findByText('部分项目搜索失败，结果可能不完整。')).toBeInTheDocument()
    expect(screen.getByText('good-alpha.ts')).toBeInTheDocument()
    expect(screen.getByText('content-alpha.ts')).toBeInTheDocument()
    expect(screen.getByText(/Beta:.*connection unavailable/)).toBeInTheDocument()

    betaUnavailable = false
    fireEvent.click(screen.getByRole('button', { name: '重试搜索' }))
    expect(await screen.findByText('good-beta.ts')).toBeInTheDocument()
    expect(await screen.findByText('content-beta.ts')).toBeInTheDocument()
    expect(screen.getByText('good-alpha.ts')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('部分项目搜索失败，结果可能不完整。')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '重试搜索' })).not.toBeInTheDocument()
  })

  it('offers more results for a truncated SSH response even when its hit count is below the budget', async () => {
    const remote: Project = { ...project, kind: 'ssh', path: 'ssh://connection/home/project' }
    useProjectStore.setState({ projects: [remote], currentProject: remote })
    mocks.findProjectForPath.mockReturnValue(remote)
    dispatch({
      list_file_extensions: () => ['ts'],
      ssh_search_files_detailed: args => ({
        hits: [{ name: 'remote.ts', path: `${remote.path}/src/remote.ts`, relative: 'src/remote.ts', is_dir: false }],
        truncated: Number(args?.limit) === 200,
        cancelled: false,
      }),
    })
    render(<SearchPanel />)
    fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
    fireEvent.change(screen.getByPlaceholderText('搜索文件名，支持 * 通配符…'), { target: { value: 'remote' } })

    const more = await screen.findByRole('button', { name: '显示更多结果' })
    expect(screen.getByText('remote.ts')).toBeInTheDocument()
    expect(mocks.safeInvoke).toHaveBeenCalledWith('文件搜索', 'ssh_search_files_detailed', expect.objectContaining({ root: remote.path, limit: 200 }))
    fireEvent.click(more)
    await waitFor(() => expect(mocks.safeInvoke).toHaveBeenCalledWith('文件搜索', 'ssh_search_files_detailed', expect.objectContaining({ root: remote.path, limit: 500 })))
    await waitFor(() => expect(screen.queryByRole('button', { name: '显示更多结果' })).not.toBeInTheDocument())
  })

  it('keeps the result list scrollable and expands or collapses every content group', async () => {
    dispatch({
      list_file_extensions: () => ['ts'],
      search_files: () => [],
      start_content_search: () => 1,
      search_file_contents: () => ({
        files: [
          {
            name: 'build.ts',
            path: 'D:/alpha/src/build.ts',
            relative: 'src/build.ts',
            matches: [
              {
                line: 7,
                text: 'const build = true',
                match_start: 6,
                match_end: 11,
              },
            ],
          },
        ],
        match_count: 1,
        files_scanned: 1,
        truncated: false,
      }),
      cancel_content_search: () => undefined,
    })
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('搜索文件或内容…')
    fireEvent.change(input, { target: { value: 'build' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('build', { selector: 'mark' })).toBeInTheDocument()
    const results = screen.getByRole('region', { name: '搜索结果' })
    expect(results).toHaveClass('min-h-0')
    expect(results.querySelector('[data-search-results-list]')).toHaveClass('min-h-0')

    const expandAll = screen.getByRole('button', { name: '展开全部' })
    const collapseAll = screen.getByRole('button', { name: '折叠全部' })
    expect(expandAll).toBeDisabled()
    expect(collapseAll).toBeEnabled()

    fireEvent.click(collapseAll)
    await waitFor(() =>
      expect(screen.queryByText('build', { selector: 'mark' })).not.toBeInTheDocument()
    )
    expect(expandAll).toBeEnabled()
    expect(collapseAll).toBeDisabled()

    fireEvent.click(expandAll)
    expect(await screen.findByText('build', { selector: 'mark' })).toBeInTheDocument()
  })

  it('skips content search for a single-character query', async () => {
    dispatch({
      list_file_extensions: () => ['ts'],
      search_files: () => [],
      start_content_search: () => 1,
      search_file_contents: () => ({
        files: [],
        match_count: 0,
        files_scanned: 0,
        truncated: false,
      }),
      cancel_content_search: () => undefined,
    })
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('搜索文件或内容…')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ query: 'a' }),
      ),
    )
    expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
      '内容搜索',
      'search_file_contents',
      expect.anything(),
    )
  })

  it('searches immediately when Enter is pressed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<SearchPanel />)
      const input = screen.getByPlaceholderText('搜索文件或内容…')
      fireEvent.change(input, { target: { value: 'app' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() =>
        expect(mocks.safeInvoke).toHaveBeenCalledWith(
          '文件搜索',
          'search_files',
          expect.objectContaining({ query: 'app' }),
        ),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for Enter or the Search button in All mode', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<SearchPanel />)
      const input = screen.getByPlaceholderText('搜索文件或内容…')
      fireEvent.change(input, { target: { value: 'app' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ query: 'app' }),
      )
      expect(screen.getByText('查询条件已修改，按 Enter 或点击查询')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '查询' }))
      await waitFor(() =>
        expect(mocks.safeInvoke).toHaveBeenCalledWith(
          '文件搜索',
          'search_files',
          expect.objectContaining({ query: 'app' }),
        ),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the previous results while an explicit query has unsubmitted edits', async () => {
    dispatch({
      list_file_extensions: () => ['tsx'],
      search_files: args => {
        const query = String(args?.query ?? '')
        return [
          {
            name: `${query}.tsx`,
            path: `D:/alpha/${query}.tsx`,
            relative: `${query}.tsx`,
            is_dir: false,
          },
        ]
      },
      start_content_search: () => 1,
      search_file_contents: () => ({
        files: [],
        match_count: 0,
        files_scanned: 1,
        truncated: false,
      }),
      cancel_content_search: () => undefined,
    })
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('搜索文件或内容…')
    fireEvent.change(input, { target: { value: 'first' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getAllByText('first.tsx').length).toBeGreaterThan(0))

    fireEvent.change(input, { target: { value: 'second' } })
    expect(screen.getAllByText('first.tsx').length).toBeGreaterThan(0)
    expect(screen.getByText('查询条件已修改，按 Enter 或点击查询')).toBeInTheDocument()
    expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
      '文件搜索',
      'search_files',
      expect.objectContaining({ query: 'second' }),
    )

    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    await waitFor(() => expect(screen.getAllByText('second.tsx').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    await waitFor(() => expect(screen.queryByText('second.tsx')).not.toBeInTheDocument())
  })

  it('reruns the submitted query when a filter changes', async () => {
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('搜索文件或内容…')
    fireEvent.change(input, { target: { value: 'app' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ query: 'app', ignoreCase: true }),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Aa' }))
    await waitFor(() =>
      expect(mocks.safeInvoke).toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ query: 'app', ignoreCase: false }),
      ),
    )
  })

  it('waits for IME composition to finish before searching', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<SearchPanel />)
      fireEvent.click(screen.getByRole('tab', { name: '文件名' }))
      const input = screen.getByPlaceholderText('搜索文件名，支持 * 通配符…')

      fireEvent.compositionStart(input)
      fireEvent.change(input, { target: { value: 'fuzhi' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
        '文件搜索',
        'search_files',
        expect.objectContaining({ query: 'fuzhi' }),
      )

      fireEvent.compositionEnd(input)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })

      await waitFor(() =>
        expect(mocks.safeInvoke).toHaveBeenCalledWith(
          '文件搜索',
          'search_files',
          expect.objectContaining({ query: 'fuzhi' }),
        ),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefills the global search input from a shortcut selection', async () => {
    render(<SearchPanel />)

    useUIStore.getState().requestGlobalSearch('selectedName')

    await waitFor(() =>
      expect(screen.getByPlaceholderText('搜索文件或内容…')).toHaveValue('selectedName')
    )
  })

  it('shows an empty-state prompt when no project is selected', () => {
    useProjectStore.setState({ projects: [], currentProject: null, unavailableProjectIds: [] })
    render(<SearchPanel />)
    expect(screen.getByText('请先选择或添加项目')).toBeInTheDocument()
  })
})
