import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readRunConfigsForImport } from './runConfigStore'
import { safeInvoke } from '../lib/tauri'
import { scanDirectoryEntries } from '../lib/fileIpc'
import type { Project } from '../types'

vi.mock('../lib/tauri', async original => ({ ...await original<typeof import('../lib/tauri')>(), safeInvoke: vi.fn() }))
vi.mock('../lib/fileIpc', () => ({ scanDirectoryEntries: vi.fn() }))
const project: Project = { id: 'p', name: 'p', path: 'ssh://host/home/app', created_at: 0, last_opened_at: 0 }
const scan = vi.mocked(scanDirectoryEntries)
const invoke = vi.mocked(safeInvoke)
beforeEach(() => { vi.resetAllMocks() })
const directory = (name: string) => ({ name, path: `${project.path}/${name}`, is_dir: true })
const runFile = { name: 'run.json', path: `${project.path}/.qingcode/run.json`, is_dir: false }

describe('strict read before import', () => {
  it('treats only a successful directory listing without run.json as absence', async () => {
    scan.mockResolvedValueOnce([directory('.qingcode')]).mockResolvedValueOnce([])
    expect(await readRunConfigsForImport(project)).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })
  it('never converts transport or permission errors to an empty configuration', async () => {
    scan.mockResolvedValueOnce([directory('.qingcode')]).mockResolvedValueOnce([runFile])
    invoke.mockRejectedValueOnce(new Error('transport disconnected'))
    await expect(readRunConfigsForImport(project)).rejects.toThrow('transport disconnected')
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['read_file'])
    scan.mockRejectedValueOnce(new Error('permission denied'))
    await expect(readRunConfigsForImport(project)).rejects.toThrow('permission denied')
  })
  it.each(['{', '{}', '{"configs":[{"id":"x","name":"x"}]}', '{"configs":[{"id":"x","name":"x","tasks":[null]}]}'])('rejects malformed configuration %s', async raw => {
    scan.mockResolvedValueOnce([directory('.qingcode')]).mockResolvedValueOnce([runFile])
    invoke.mockResolvedValueOnce(raw)
    await expect(readRunConfigsForImport(project)).rejects.toThrow()
  })
  it('reads legacy configurations without migrating or losing fields', async () => {
    scan.mockResolvedValueOnce([directory('.nestcode')]).mockResolvedValueOnce([runFile])
    const configs = [{ id: 'x', name: 'x', future: 'preserved', tasks: [{ id: 't', type: 'command', target: 'echo ok', os: { windows: { target: 'echo win' } } }] }]
    invoke.mockResolvedValueOnce(JSON.stringify({ configs }))
    expect(await readRunConfigsForImport(project)).toEqual(configs)
    expect(invoke.mock.calls.map(call => call[1])).toEqual(['read_file'])
    expect(invoke.mock.calls[0][2]?.path).toBe(`${project.path}/.nestcode/run.json`)
  })
  it('preserves OS-only tasks while providing safe common defaults to the panel', async () => {
    scan.mockResolvedValueOnce([directory('.qingcode')]).mockResolvedValueOnce([runFile])
    invoke.mockResolvedValueOnce(JSON.stringify({ configs: [{ id: 'x', name: 'x', tasks: [{ id: 'os', os: { linux: { target: 'echo linux' } } }] }] }))
    expect((await readRunConfigsForImport(project))[0].tasks[0]).toEqual({ id: 'os', type: 'command', target: '', os: { linux: { target: 'echo linux' } } })
  })
})
