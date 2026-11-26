import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '@qn/protocol'
import { repoKey } from './gitModel'
import { refreshGit, startGitPolling, useGit } from './gitStore'

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }))
vi.mock('../workspace/serverCall', () => ({ serverCall: callMock, onServerEvt: vi.fn() }))

type Params = Record<string, unknown>
type Calls = Array<[string, string, Params]>
const calls = (): Calls => callMock.mock.calls as Calls

const commit = {
  hash: 'abcdef123456',
  parents: [],
  author: 'me',
  email: 'me@example.com',
  date: 1_700_000_000_000,
  subject: 'init',
}
const branches = { current: 'main', local: [{ name: 'main', head: 'abc' }], remote: [] }

let upstream: string | undefined
let hook: ((method: string, params: Params) => Promise<unknown> | null) | null

const status = (): GitStatusResult => ({
  root: '/repo',
  branch: 'main',
  head: 'abc',
  upstream,
  ahead: 1,
  behind: 2,
  files: [],
})

const base = async (method: string, params: Params = {}): Promise<unknown> => {
  switch (method) {
    case 'git.status':
      return status()
    case 'git.branches':
      return branches
    case 'git.log':
      return { commits: params.skip ? [] : [commit] }
    case 'git.commitFiles':
      return { files: [{ path: 'src/a.ts', status: 'M' }] }
    default:
      return {}
  }
}

beforeEach(() => {
  useGit.setState({ repos: {} })
  upstream = undefined
  hook = null
  callMock.mockReset()
  callMock.mockImplementation(async (_targetId: string, method: string, params: Params = {}) => {
    const custom = hook?.(method, params)
    return custom ?? base(method, params)
  })
})

describe('refresh', () => {
  it('按 targetId + cwd 分仓加载 status / branches / log', async () => {
    await useGit.getState().refresh('local', '/repo')
    const repo = useGit.getState().repos[repoKey('local', '/repo')]
    expect(repo?.status).toEqual(status())
    expect(repo?.branches?.current).toBe('main')
    expect(repo?.commits).toEqual([commit])
    expect(repo?.hasMore).toBe(false)
    expect(repo?.loading).toBe(false)
    expect(repo?.error).toBeNull()
    expect(useGit.getState().repos[repoKey('local', '/other')]).toBeUndefined()

    await refreshGit('local', '/other')
    expect(useGit.getState().repos[repoKey('local', '/other')]?.status).toEqual(status())
  })

  it('并发刷新合并为一次请求；includeLog=false 不重载历史', async () => {
    await Promise.all([
      useGit.getState().refresh('local', '/repo'),
      useGit.getState().refresh('local', '/repo'),
    ])
    expect(calls().filter(([, method]) => method === 'git.status')).toHaveLength(1)

    callMock.mockClear()
    await useGit.getState().refresh('local', '/repo', false)
    expect(calls().some(([, method]) => method === 'git.log')).toBe(false)
    expect(calls().some(([, method]) => method === 'git.status')).toBe(true)
  })

  it('在途轮询遇到整刷请求会升级为含 log 的刷新', async () => {
    await Promise.all([
      useGit.getState().refresh('local', '/weak', false),
      useGit.getState().refresh('local', '/weak', true),
    ])
    expect(calls().filter(([, method]) => method === 'git.status')).toHaveLength(1)
    expect(calls().filter(([, method]) => method === 'git.log')).toHaveLength(1)
  })

  it('not_repo 错误给出空态码并清掉旧状态', async () => {
    await useGit.getState().refresh('local', '/repo')
    hook = (method) =>
      method.startsWith('git.') ? Promise.reject({ code: 'not_repo', message: 'fatal: not a git repo' }) : null
    await useGit.getState().refresh('local', '/repo')
    const repo = useGit.getState().repos[repoKey('local', '/repo')]
    expect(repo?.errorCode).toBe('not_repo')
    expect(repo?.error).toBe('当前目录不是 Git 仓库')
    expect(repo?.status).toBeNull()
    useGit.getState().clearError('local', '/repo')
    expect(useGit.getState().repos[repoKey('local', '/repo')]?.error).toBeNull()
  })
})

describe('操作', () => {
  it('操作期间防重复点击，成功后整刷', async () => {
    const gate: { release?: () => void } = {}
    hook = (method) => {
      if (method !== 'git.stage') return null
      return new Promise((resolve) => {
        gate.release = () => resolve({})
      })
    }
    const first = useGit.getState().stage('local', '/repo', ['a.ts'])
    expect(useGit.getState().repos[repoKey('local', '/repo')]?.operation).toBe('stage')
    expect(await useGit.getState().stage('local', '/repo', ['a.ts'])).toBe(false)
    expect(calls().filter(([, method]) => method === 'git.stage')).toHaveLength(1)
    gate.release?.()
    expect(await first).toBe(true)
    expect(useGit.getState().repos[repoKey('local', '/repo')]?.operation).toBeNull()
    expect(calls().filter(([, method]) => method === 'git.status')).toHaveLength(1)
  })

  it('失败保留 operationError，同时尽力刷新状态', async () => {
    hook = (method) =>
      method === 'git.commit'
        ? Promise.reject({ code: 'git_failed', message: 'fatal: hooks failed' })
        : null
    expect(await useGit.getState().commit('local', '/repo', 'msg')).toBe(false)
    const repo = useGit.getState().repos[repoKey('local', '/repo')]
    expect(repo?.operationError).toContain('Git 命令失败')
    expect(repo?.operation).toBeNull()
    expect(repo?.error).toBeNull()
  })

  it('push 无 upstream 时带 setUpstream', async () => {
    await useGit.getState().refresh('local', '/repo')
    callMock.mockClear()
    expect(await useGit.getState().push('local', '/repo')).toBe(true)
    expect(calls().find(([, method]) => method === 'git.push')?.[2]).toEqual({
      cwd: '/repo',
      setUpstream: true,
    })

    upstream = 'origin/main'
    await useGit.getState().refresh('local', '/repo')
    callMock.mockClear()
    await useGit.getState().push('local', '/repo')
    expect(calls().find(([, method]) => method === 'git.push')?.[2]).toEqual({ cwd: '/repo' })
  })

  it('switch / commit / discard 参数透传', async () => {
    await useGit.getState().switchBranch('local', '/repo', 'feature/x', true)
    await useGit.getState().commit('local', '/repo', 'msg', true)
    await useGit.getState().discard('local', '/repo', ['new.ts'], true)
    expect(calls().find(([, method]) => method === 'git.switch')?.[2]).toEqual({
      cwd: '/repo', branch: 'feature/x', create: true,
    })
    expect(calls().find(([, method]) => method === 'git.commit')?.[2]).toEqual({
      cwd: '/repo', message: 'msg', amend: true,
    })
    expect(calls().find(([, method]) => method === 'git.discard')?.[2]).toEqual({
      cwd: '/repo', paths: ['new.ts'], includeUntracked: true,
    })
  })
})

describe('历史分页与提交文件', () => {
  it('滚动分页追加，短页后 hasMore=false', async () => {
    const full = Array.from({ length: 30 }, (_, index) => ({ ...commit, hash: `h${index}` }))
    hook = (method, params) =>
      method === 'git.log'
        ? Promise.resolve({ commits: params.skip ? [{ ...commit, hash: 'last' }] : full })
        : null
    await useGit.getState().refresh('local', '/repo')
    const key = repoKey('local', '/repo')
    expect(useGit.getState().repos[key]?.hasMore).toBe(true)
    await useGit.getState().loadMore('local', '/repo')
    expect(useGit.getState().repos[key]?.commits).toHaveLength(31)
    expect(useGit.getState().repos[key]?.hasMore).toBe(false)
    await useGit.getState().loadMore('local', '/repo')
    expect(calls().filter(([, method, params]) => method === 'git.log' && params.skip === 30)).toHaveLength(1)
  })

  it('提交文件按 hash 缓存，不重复请求', async () => {
    const files = await useGit.getState().loadCommitFiles('local', '/repo', 'abcdef1')
    expect(files).toEqual([{ path: 'src/a.ts', status: 'M' }])
    await useGit.getState().loadCommitFiles('local', '/repo', 'abcdef1')
    expect(calls().filter(([, method]) => method === 'git.commitFiles')).toHaveLength(1)
  })
})

describe('轮询', () => {
  it('可见时每 5s 刷新，全部注销后停止', async () => {
    vi.useFakeTimers()
    const stop1 = startGitPolling('local', '/repo')
    const stop2 = startGitPolling('local', '/repo')
    try {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls().filter(([, method]) => method === 'git.status').length).toBeGreaterThan(0)
      stop1()
      const afterOneStop = calls().length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls().length).toBeGreaterThan(afterOneStop)
      stop2()
      const afterAllStops = calls().length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls().length).toBe(afterAllStops)
    } finally {
      stop1()
      stop2()
      vi.useRealTimers()
    }
  })
})
