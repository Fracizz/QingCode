// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CommandPalette from './CommandPalette'
import { useCommandPaletteStore } from '../store/commandPaletteStore'
import { useProjectStore } from '../store/projectStore'
import { searchFiles, type SearchFilesResult } from '../lib/searchFiles'

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }))
vi.mock('../lib/commands', () => ({
  buildCommands: () => [{ id: 'test', title: '测试命令', run: runCommand }],
  filterCommands: (commands: unknown[]) => commands,
  resolveCommandShortcut: () => undefined,
}))
vi.mock('../lib/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/tauri')>(),
  isTauri: () => true,
}))
vi.mock('../lib/searchFiles', () => ({ searchFiles: vi.fn() }))
vi.mock('../lib/excludeSettings', () => ({
  loadExcludeSettingsForProject: async () => ({ searchExclude: [], useIgnoreFiles: true, followSymlinks: false }),
}))
const initialProjects = useProjectStore.getState()
beforeEach(() => {
  runCommand.mockReset()
  vi.mocked(searchFiles).mockReset()
  useProjectStore.setState({ projects: [], projectTrees: {}, unavailableProjectIds: [], currentProject: null })
})
afterEach(() => {
  useProjectStore.setState(initialProjects, true)
  useCommandPaletteStore.getState().closePalette()
})
function openFiles() {
  useProjectStore.setState({ projects: [{ id: 'p', name: '项目', path: 'D:/project', created_at: 1, last_opened_at: 1 }] })
  useCommandPaletteStore.getState().openPalette('readme')
  return render(<CommandPalette />)
}

describe('CommandPalette input and remote result feedback', () => {
  it('does not execute a command when Enter confirms an IME candidate', async () => {
    useCommandPaletteStore.getState().openPalette('>')
    render(<CommandPalette />)
    const input = screen.getByRole('combobox')
    await waitFor(() => expect(input).toHaveValue('>'))
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(runCommand).not.toHaveBeenCalled()
    expect(useCommandPaletteStore.getState().open).toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(runCommand).toHaveBeenCalledOnce()
  })
  it('shows loading until an empty search actually finishes', async () => {
    let finish!: (value: SearchFilesResult) => void
    vi.mocked(searchFiles).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    openFiles()
    await waitFor(() => expect(searchFiles).toHaveBeenCalledOnce())
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('没有匹配的文件')).not.toBeInTheDocument()
    await act(async () => finish({ hits: [], truncated: false }))
    expect(screen.getByText('没有匹配的文件')).toBeInTheDocument()
  })
  it('shows incomplete-search feedback and can retry cancelled searches', async () => {
    vi.mocked(searchFiles).mockResolvedValueOnce({ hits: [], truncated: false, cancelled: true })
    vi.mocked(searchFiles).mockResolvedValueOnce({ hits: [], truncated: true })
    openFiles()
    expect(await screen.findByText('搜索未完成，请重试')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('结果已达搜索上限，请细化关键词')).toBeInTheDocument()
  })
  it('finishes loading when every root fails and a retry searches every root again', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(searchFiles).mockRejectedValue(new Error('unavailable'))
    useProjectStore.setState({ projects: [
      { id: 'a', name: '项目A', path: 'D:/a', created_at: 1, last_opened_at: 1 },
      { id: 'b', name: '项目B', path: 'D:/b', created_at: 1, last_opened_at: 1 },
    ] })
    useCommandPaletteStore.getState().openPalette('readme')
    render(<CommandPalette />)
    expect(await screen.findByText('搜索未完成，请重试')).toBeInTheDocument()
    expect(searchFiles).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('项目A、项目B')
    vi.mocked(searchFiles).mockResolvedValue({ hits: [], truncated: false })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('没有匹配的文件')).toBeInTheDocument()
    expect(searchFiles).toHaveBeenCalledTimes(4)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    warning.mockRestore()
  })

})
