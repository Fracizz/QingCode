// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RunConfigDiscovery from './RunConfigDiscovery'
import { scanDirectoryEntries, readFileSlice } from '../lib/fileIpc'
import { safeInvoke } from '../lib/tauri'
import { useRunConfigStore } from '../store/runConfigStore'
import type { Project } from '../types'

vi.mock('../lib/fileIpc', () => ({ scanDirectoryEntries: vi.fn(), readFileSlice: vi.fn() }))
vi.mock('../lib/tauri', async original => ({ ...await original<typeof import('../lib/tauri')>(), safeInvoke: vi.fn() }))
const project: Project = { id: 'p', name: 'p', path: '/app', created_at: 0, last_opened_at: 0 }
const existing = [{ id: 'keep', name: 'keep', tasks: [{ id: 't', type: 'command', target: 'echo keep' }] }]

beforeEach(() => {
  vi.resetAllMocks()
  useRunConfigStore.setState({ configsByProject: {}, loadedProjects: new Set() })
  vi.mocked(scanDirectoryEntries).mockImplementation(async ({ path }) => path === '/app' ? [
    { name: 'package.json', path: '/app/package.json', is_dir: false },
    { name: '.qingcode', path: '/app/.qingcode', is_dir: true },
  ] : [{ name: 'run.json', path: '/app/.qingcode/run.json', is_dir: false }])
  const text = JSON.stringify({ scripts: { dev: 'vite' } })
  vi.mocked(readFileSlice).mockResolvedValue({ text, offset: 0, len: text.length, file_size: text.length, eof: true })
  vi.mocked(safeInvoke).mockResolvedValue(JSON.stringify({ configs: existing }))
})
afterEach(cleanup)

it('aborts import on a transient read failure without overwriting existing configurations', async () => {
  const close = vi.fn()
  render(<RunConfigDiscovery project={project} onClose={close} />)
  const task = await screen.findByRole('checkbox', { name: '选择发现的任务「dev」' })
  fireEvent.click(task)
  vi.mocked(safeInvoke).mockRejectedValueOnce(new Error('SSH disconnected during read'))
  fireEvent.click(screen.getByRole('button', { name: '导入选中（1）' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('SSH disconnected during read')
  expect(vi.mocked(safeInvoke).mock.calls.every(call => call[1] === 'read_file')).toBe(true)
  expect(useRunConfigStore.getState().configsByProject.p).toEqual(existing)
  expect(close).not.toHaveBeenCalled()
  expect(task).toBeChecked()
  // Retrying after transport recovery appends to the same existing file.
  fireEvent.click(screen.getByRole('button', { name: '导入选中（1）' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  const write = vi.mocked(safeInvoke).mock.calls.find(call => call[1] === 'write_file')
  expect(JSON.parse(String(write?.[2]?.content)).configs[0]).toEqual(existing[0])
})
