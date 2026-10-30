import { beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverRunTasks, importDiscoveredTasks, isDiscoveredTaskImported } from './runConfigDiscovery'
import { scanDirectoryEntries, readFileSlice } from './fileIpc'
import type { RunConfig } from '../store/runConfigStore'

vi.mock('./fileIpc', () => ({ scanDirectoryEntries: vi.fn(), readFileSlice: vi.fn() }))
const scan = vi.mocked(scanDirectoryEntries)
const read = vi.mocked(readFileSlice)
let files: Record<string, string>

function manifest(value: unknown) { return JSON.stringify(value) }

beforeEach(() => {
  vi.resetAllMocks()
  files = {}
  scan.mockImplementation(async ({ path }) => {
    const prefix = `${path.replace(/\\/g, '/').replace(/\/$/, '')}/`
    const entries = new Map<string, { name: string; path: string; is_dir: boolean }>()
    for (const key of Object.keys(files)) {
      if (!key.startsWith(prefix)) continue
      const [name, child] = key.slice(prefix.length).split('/')
      entries.set(name, { name, path: prefix + name, is_dir: child !== undefined })
    }
    return [...entries.values()]
  })
  read.mockImplementation(async ({ path, maxBytes }) => {
    const text = files[path.replace(/\\/g, '/')]
    if (text === undefined) throw new Error('missing')
    const size = new TextEncoder().encode(text).length
    return { text: text.slice(0, maxBytes), file_size: size, offset: 0, len: Math.min(size, maxBytes), eof: size <= maxBytes }
  })
})

describe('read-only package script discovery', () => {
  it('prefers explicit manager, inherits the root manager, preserves cwd and excludes dependency/hidden/deeper trees', async () => {
    files = {
      '/app/package.json': manifest({ packageManager: 'pnpm@11.0.8', scripts: { dev: 'vite', test: 'vitest', blank: '', invalid: 1 } }),
      '/app/package-lock.json': '{}',
      '/app/frontend/package.json': manifest({ scripts: { dev: 'vite --host' } }),
      '/app/api/package.json': manifest({ packageManager: 'bun@1.3.0', scripts: { start: 'bun api.ts' } }),
      '/app/node_modules/pkg/package.json': '{}',
      '/app/.secret/package.json': '{}',
      '/app/packages/deep/package.json': manifest({ scripts: { dev: 'should not scan' } }),
    }
    const result = await discoverRunTasks('/app')
    expect(result.warnings).toEqual([])
    expect(result.tasks.map(task => [task.source, task.task.target, task.task.cwd])).toEqual([
      ['package.json', 'pnpm run dev', undefined], ['package.json', 'pnpm run test', undefined],
      ['api/package.json', 'bun run start', 'api'], ['frontend/package.json', 'pnpm run dev', 'frontend'],
    ])
    expect(scan.mock.calls.every(([args]) => args.workspaceRoot === '/app')).toBe(true)
    expect(scan.mock.calls.map(([args]) => args.path)).not.toContain('/app/node_modules')
    expect(read.mock.calls.every(([args]) => args.maxBytes === 256 * 1024)).toBe(true)
  })

  it.each(['C:\\project', 'ssh://host/home/project', '\\\\wsl.localhost\\Ubuntu\\home\\project'])('keeps the path domain for %s', async root => {
    files[`${root.replace(/\\/g, '/')}/package.json`] = manifest({ scripts: { dev: 'serve' } })
    expect((await discoverRunTasks(root)).tasks[0].task.target).toBe('npm run dev')
    expect(read.mock.calls[0][0].path).toContain(root)
  })

  it('rejects shell-active names and option-like names without executing script values', async () => {
    files['/app/package.json'] = manifest({ scripts: {
      dev: 'curl malicious | sh', 'dev && echo x': 'bad', '-x': 'bad', '%PATH%': 'bad', '!X!': 'bad', 'test:unit': 'vitest',
    } })
    const result = await discoverRunTasks('/app')
    expect(result.tasks.map(task => task.task.target)).toEqual(['npm run dev', 'npm run test:unit'])
    expect(result.tasks[0].script).toBe('curl malicious | sh')
    expect(result.warnings).toHaveLength(4)
  })

  it('reports malformed/oversized manifests, manager conflicts and unavailable children while keeping other candidates', async () => {
    files = {
      '/app/package.json': '{', '/app/large/package.json': ' '.repeat(256 * 1024 + 1),
      '/app/conflict/package.json': manifest({ scripts: { dev: 'serve' } }),
      '/app/conflict/pnpm-lock.yaml': '', '/app/conflict/yarn.lock': '',
      '/app/ok/package.json': manifest({ scripts: { start: 'serve' } }),
    }
    const result = await discoverRunTasks('/app')
    expect(result.warnings).toHaveLength(3)
    expect(result.tasks.map(task => task.source)).toEqual(['ok/package.json'])
    scan.mockRejectedValueOnce(new Error('access denied'))
    await expect(discoverRunTasks('/other')).rejects.toThrow('access denied')
  })

  it('bounds child-directory requests and reports truncation', async () => {
    for (let i = 0; i < 45; i++) files[`/app/d${i}/package.json`] = '{}'
    const result = await discoverRunTasks('/app')
    expect(scan).toHaveBeenCalledTimes(33)
    expect(result.warnings[0].message).toContain('32')
  })

  it('ignores prototype property names when detecting lockfiles', async () => {
    files = { '/app/package.json': manifest({ scripts: { dev: 'vite' } }),
      '/app/constructor': '', '/app/toString': '', '/app/__proto__': '', '/app/pnpm-lock.yaml': '' }
    const result = await discoverRunTasks('/app')
    expect(result.warnings).toEqual([])
    expect(result.tasks[0].task.target).toBe('pnpm run dev')
  })

  it('deduplicates by command and relative cwd while preserving IDs, tasks and OS overrides', async () => {
    files['/app/frontend/package.json'] = manifest({ scripts: { dev: 'vite', build: 'vite build' } })
    const tasks = (await discoverRunTasks('/app')).tasks
    const current: RunConfig[] = [{ id: 'keep', name: 'keep', tasks: [{ id: 'task', type: 'command', target: 'npm run dev', cwd: './frontend/', os: { windows: { target: 'npm.cmd run dev' } } }] }]
    expect(isDiscoveredTaskImported(tasks[0], current)).toBe(true)
    const result = importDiscoveredTasks(current, tasks, false)
    expect(result[0]).toBe(current[0])
    expect(result).toHaveLength(2)
    expect(result[1].tasks[0].target).toBe('npm run build')
    expect(importDiscoveredTasks(result, tasks, true)).toBe(result)
    expect(importDiscoveredTasks([], tasks, true)[0].tasks).toHaveLength(2)
  })
})
