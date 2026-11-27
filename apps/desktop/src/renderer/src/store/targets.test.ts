import { afterEach, expect, it, vi } from 'vitest'
import { LOCAL_TARGET, type SshTarget, type TargetStateEvent } from '../../../shared/backendApi'
import { useTargets } from './targets'

const backend = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), onBackendRestart: vi.fn() }))
vi.mock('../lib/backend', () => backend)

afterEach(() => {
  vi.unstubAllGlobals()
  useTargets.setState(useTargets.getInitialState())
})

it('加载目标时保留上次远程选择，启动连接的状态由后端更新', async () => {
  const remote: SshTarget = { id: 'remote', name: '远程', kind: 'ssh', host: 'host', port: 22, username: 'user', auth: { kind: 'password' } }
  const stored = new Map([['qn-last-target', remote.id]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
  backend.call.mockResolvedValueOnce([LOCAL_TARGET, remote]).mockResolvedValueOnce(undefined)
  await useTargets.getState().load()
  expect(useTargets.getState().selectedId).toBe('local')
  expect(stored.get('qn-last-target')).toBe(remote.id)

  useTargets.getState().restoreLast()
  expect(useTargets.getState().selectedId).toBe(remote.id)
  expect(backend.call).toHaveBeenLastCalledWith('target.connect', { id: remote.id, startup: true })
  await Promise.resolve()
  expect(useTargets.getState().states[remote.id]?.state).toBe('connecting')
  const onState = backend.on.mock.calls.find(([name]) => name === 'target.state')?.[1] as (event: TargetStateEvent) => void

  useTargets.getState().select('local')
  onState({ id: remote.id, state: 'error', detail: '启动时连接超时' })
  expect(useTargets.getState().states[remote.id]?.state).toBe('error')
  expect(useTargets.getState().selectedId).toBe('local')
  expect(stored.get('qn-last-target')).toBe('local')
})

it('选中的目标加入侧栏，从侧栏移除活动目标时回到本机', () => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
  useTargets.getState().select('remote')
  useTargets.getState().select('other')
  expect(useTargets.getState().sidebarIds).toEqual(['remote', 'other'])
  useTargets.getState().hideFromSidebar('other')
  expect(useTargets.getState().sidebarIds).toEqual(['remote'])
  expect(useTargets.getState().selectedId).toBe('local')
  expect(JSON.parse(stored.get('qn-sidebar-targets') ?? '[]')).toEqual(['remote'])
})
