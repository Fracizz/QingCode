// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '../types'
import type { GitWorkdirStatus } from '../lib/git/gitStatus'

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  isSshResource: (path: string) => path.startsWith('ssh://'),
}))
vi.mock('../lib/ipc/git', () => ({
  getGitWorkdirStatus: vi.fn(),
  getGitStatus: vi.fn(),
  getGitHead: vi.fn(async () => null),
}))
vi.mock('../store/projectStore', async () => {
  const { create } = await import('zustand')
  return { useProjectStore: create(() => ({ currentProject: null })) }
})
vi.mock('../store/editorStore', async () => {
  const { create } = await import('zustand')
  return { useEditorStore: create(() => ({ tabs: [], projectSessions: {} })) }
})
vi.mock('../store/terminalStore', async () => {
  const { create } = await import('zustand')
  return { useTerminalStore: create(() => ({ terminals: [] })) }
})
vi.mock('../lib/projectIndicatorSettings', () => ({
  isProjectIndicatorsEnabled: () => true,
  PROJECT_INDICATORS_EVENT: 'test:indicators',
}))
vi.mock('../lib/gitRefreshSettings', () => ({
  getGitRefreshIntervalStartMinutes: () => 5,
  DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES: 5,
  parseGitRefreshIntervalStartMinutes: () => 5,
  GIT_REFRESH_INTERVAL_START_EVENT: 'test:interval',
}))

import { getGitWorkdirStatus } from '../lib/ipc/git'
import { useProjectStore } from '../store/projectStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { useProjectIndicators } from './useProjectIndicators'
import { useActiveGitDirtyCount } from './useActiveGitDirtyCount'

const alpha: Project = {
  id: 'a',
  name: 'a',
  path: 'ssh://connection/home/alpha',
  created_at: 0,
  last_opened_at: 0,
}
const beta: Project = { ...alpha, id: 'b', name: 'b', path: 'ssh://connection/home/beta' }
const projects = [alpha, beta]
const unavailable: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  useGitStatusStore.getState().clear()
  useProjectStore.setState({ currentProject: alpha })
})
afterEach(() => useGitStatusStore.getState().clear())

it('keeps tab, activity badge and SCM list at 98 through a project switch and pending refresh', async () => {
  useGitStatusStore.getState().applyFromGitStatus(alpha.path, {
    is_repository: true,
    branch: 'alpha',
    changes: [],
  })
  vi.mocked(getGitWorkdirStatus).mockResolvedValueOnce({
    branch: 'beta',
    dirty_count: 98,
    entries: Array.from({ length: 98 }, (_, i) => ({ path: `${beta.path}/${i}.ts`, status: ' M' })),
  })
  await useGitStatusStore.getState().refresh(beta.path, { background: true })
  const seen: number[][] = []
  const { result } = renderHook(() => {
    const indicators = useProjectIndicators(projects, unavailable)
    const active = useActiveGitDirtyCount()
    const current = useProjectStore(s => s.currentProject)
    const panel = useGitStatusStore(s => (current ? s.peekPanelStatus(current.path) : null))
    if (current?.id === beta.id)
      seen.push([indicators.b.gitChanges, active, panel?.changes.length ?? 0])
    return { indicators, active }
  })
  expect(result.current.indicators.b.gitChanges).toBe(98)
  expect(result.current.active).toBe(0)

  let release!: (value: GitWorkdirStatus) => void
  vi.mocked(getGitWorkdirStatus).mockReturnValueOnce(
    new Promise(resolve => {
      release = resolve
    })
  )
  let pending!: Promise<void>
  act(() => {
    useProjectStore.setState({ currentProject: beta })
    pending = useGitStatusStore.getState().refresh(beta.path, { reuseInFlight: true })
  })
  expect(result.current.active).toBe(98)
  expect(result.current.indicators.b.gitChanges).toBe(98)
  await act(async () => {
    release({
      branch: 'beta',
      dirty_count: 98,
      entries: Array.from({ length: 98 }, (_, i) => ({
        path: `${beta.path}/${i}.ts`,
        status: ' M',
      })),
    })
    await pending
  })
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(counts => counts.every(count => count === 98))).toBe(true)
})
