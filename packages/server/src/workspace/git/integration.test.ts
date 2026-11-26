import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GitCommit, GitStatusResult, WorkspaceMethod } from '@qn/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceContext } from '../registry'
import { gitHandlers } from './index'

const dirs: string[] = []
const ctx: WorkspaceContext = {
  clientId: 1,
  emit() {},
  onClose() {},
  log() {},
}

async function call<T>(method: WorkspaceMethod, params: Record<string, unknown>): Promise<T> {
  const handler = gitHandlers[method]
  if (!handler) throw new Error(`未登记处理方法: ${method}`)
  return (await handler(params, ctx)) as T
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  })
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeRepo(): string {
  const dir = tempDir('qn-git-it-')
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Tester'])
  git(dir, ['config', 'user.email', 'tester@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

function write(dir: string, name: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(dir, name), content)
}

function read(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), 'utf8')
}

function commitAll(dir: string, message: string): string {
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', message])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('git.* 集成（os.tmpdir() 下的真实仓库）', () => {
  it('全部方法都已登记', () => {
    const methods: WorkspaceMethod[] = [
      'git.status',
      'git.diff',
      'git.show',
      'git.stage',
      'git.unstage',
      'git.discard',
      'git.commit',
      'git.branches',
      'git.switch',
      'git.fetch',
      'git.pull',
      'git.push',
      'git.log',
      'git.commitFiles',
    ]
    expect(methods.every((method) => typeof gitHandlers[method] === 'function')).toBe(true)
  })

  it('git.status：空仓库、root、分支头', async () => {
    const dir = makeRepo()
    const status = await call<GitStatusResult>('git.status', { cwd: dir })
    expect(status.branch).toBe('main')
    expect(status.head).toBeNull()
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
    expect(status.files).toEqual([])
    expect(status.root.replace(/\\/g, '/').toLowerCase()).toBe(
      path.resolve(dir).replace(/\\/g, '/').toLowerCase(),
    )
  }, 30_000)

  it('cwd 可以是仓库内任意子目录；空仓库 branches 仍有当前分支', async () => {
    const dir = makeRepo()
    fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true })
    write(dir, path.join('src', 'nested', 'a.txt'), 'a\n')
    commitAll(dir, 'init')
    const sub = path.join(dir, 'src', 'nested')

    const status = await call<GitStatusResult>('git.status', { cwd: sub })
    expect(status.root.replace(/\\/g, '/').toLowerCase()).toBe(
      path.resolve(dir).replace(/\\/g, '/').toLowerCase(),
    )
    expect(status.files).toEqual([])

    write(dir, path.join('src', 'nested', 'a.txt'), 'a\nb\n')
    const changed = await call<GitStatusResult>('git.status', { cwd: sub })
    expect(changed.files[0]?.path).toBe('src/nested/a.txt')
    const diff = await call<{ diff: string }>('git.diff', {
      cwd: sub,
      path: path.join(sub, 'a.txt'),
    })
    expect(diff.diff).toContain('+b')

    const empty = makeRepo()
    expect(await call('git.branches', { cwd: empty })).toEqual({
      current: 'main',
      local: [],
      remote: [],
    })
  }, 30_000)

  it('git.status：修改、暂存、未跟踪、重命名', async () => {
    const dir = makeRepo()
    write(dir, 'base.txt', 'one\n')
    commitAll(dir, 'init')
    write(dir, 'base.txt', 'one\ntwo\n')
    write(dir, 'untracked file.txt', 'u\n')
    write(dir, 'staged.txt', 's\n')
    git(dir, ['add', 'staged.txt'])

    const status = await call<GitStatusResult>('git.status', { cwd: dir })
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'base.txt', index: '.', worktree: 'M' }),
        expect.objectContaining({ path: 'untracked file.txt', index: '?', worktree: '?' }),
        expect.objectContaining({ path: 'staged.txt', index: 'A', worktree: '.' }),
      ]),
    )

    commitAll(dir, 'second')
    git(dir, ['mv', 'staged.txt', 'renamed.txt'])
    const renamed = await call<GitStatusResult>('git.status', { cwd: dir })
    expect(renamed.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'renamed.txt', origPath: 'staged.txt', index: 'R' }),
      ]),
    )
  }, 30_000)

  it('git.stage / git.commit / git.log / git.commitFiles', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'a\n')
    const first = commitAll(dir, 'init')
    write(dir, 'b.txt', 'b\n')

    await call('git.stage', { cwd: dir, paths: [path.join(dir, 'b.txt')] })
    const { commit } = await call<{ commit: string }>('git.commit', {
      cwd: dir,
      message: 'add b\n\n中文 & "quotes"',
    })
    expect(commit).toMatch(/^[0-9a-f]{40}$/)

    const log = await call<{ commits: GitCommit[] }>('git.log', { cwd: dir })
    expect(log.commits).toHaveLength(2)
    expect(log.commits[0]).toMatchObject({
      hash: commit,
      parents: [first],
      author: 'Tester',
      email: 'tester@example.com',
      subject: 'add b',
    })
    expect(log.commits[0]?.date).toBeGreaterThan(1_000_000_000_000)

    const skipped = await call<{ commits: GitCommit[] }>('git.log', {
      cwd: dir,
      limit: 1,
      skip: 1,
    })
    expect(skipped.commits).toHaveLength(1)
    expect(skipped.commits[0]?.subject).toBe('init')

    const byPath = await call<{ commits: GitCommit[] }>('git.log', {
      cwd: dir,
      path: path.join(dir, 'a.txt'),
    })
    expect(byPath.commits.map((item) => item.subject)).toEqual(['init'])

    const files = await call<{ files: Array<{ path: string; status: string }> }>(
      'git.commitFiles',
      { cwd: dir, commit },
    )
    expect(files.files).toEqual([{ path: 'b.txt', status: 'A' }])
    const rootFiles = await call<{ files: Array<{ path: string; status: string }> }>(
      'git.commitFiles',
      { cwd: dir, commit: first },
    )
    expect(rootFiles.files).toEqual([{ path: 'a.txt', status: 'A' }])

    const empty = makeRepo()
    expect(await call<{ commits: GitCommit[] }>('git.log', { cwd: empty })).toEqual({
      commits: [],
    })
  }, 30_000)

  it('git.diff：工作区、暂存、commit、未跟踪文件', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'a\nb\nc\n')
    const first = commitAll(dir, 'init')
    write(dir, 'a.txt', 'a\nB\nc\n')

    const work = await call<{ diff: string; truncated: boolean }>('git.diff', {
      cwd: dir,
      path: path.join(dir, 'a.txt'),
    })
    expect(work.diff).toContain('-b')
    expect(work.diff).toContain('+B')
    expect(work.truncated).toBe(false)

    const stagedEmpty = await call<{ diff: string }>('git.diff', { cwd: dir, staged: true })
    expect(stagedEmpty.diff).toBe('')

    git(dir, ['add', 'a.txt'])
    const staged = await call<{ diff: string }>('git.diff', {
      cwd: dir,
      staged: true,
      contextLines: 0,
      path: 'a.txt',
    })
    expect(staged.diff).toContain('+B')

    const commitDiff = await call<{ diff: string }>('git.diff', {
      cwd: dir,
      commit: first,
      path: 'a.txt',
    })
    expect(commitDiff.diff).toContain('+a')

    write(dir, 'fresh file.txt', 'new line\n')
    const untracked = await call<{ diff: string; truncated: boolean }>('git.diff', {
      cwd: dir,
      path: path.join(dir, 'fresh file.txt'),
    })
    expect(untracked.diff).toContain('+new line')
    expect(untracked.truncated).toBe(false)
  }, 30_000)

  it('git.show：正文、对象不存在、二进制', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'hello\n')
    commitAll(dir, 'init')

    expect(await call('git.show', { cwd: dir, path: path.join(dir, 'a.txt') })).toEqual({
      content: 'hello\n',
      binary: false,
      exists: true,
    })
    expect(await call('git.show', { cwd: dir, path: 'nope.txt' })).toEqual({
      content: '',
      binary: false,
      exists: false,
    })
    expect(await call('git.show', { cwd: dir, path: 'a.txt', ref: 'nosuchref' })).toEqual({
      content: '',
      binary: false,
      exists: false,
    })

    write(dir, 'bin.dat', Buffer.from([0, 1, 2, 255]))
    commitAll(dir, 'binary')
    expect(await call('git.show', { cwd: dir, path: 'bin.dat', ref: 'HEAD' })).toEqual({
      content: '',
      binary: true,
      exists: true,
    })
  }, 30_000)

  it('git.unstage / git.discard（含空仓库与 includeUntracked）', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'v1\n')
    commitAll(dir, 'init')
    write(dir, 'a.txt', 'v2\n')
    git(dir, ['add', 'a.txt'])

    await call('git.unstage', { cwd: dir, paths: ['a.txt'] })
    let status = await call<GitStatusResult>('git.status', { cwd: dir })
    expect(status.files[0]).toMatchObject({ path: 'a.txt', index: '.', worktree: 'M' })

    write(dir, 'junk.txt', 'junk\n')
    await call('git.discard', { cwd: dir, paths: ['a.txt', 'junk.txt'] })
    expect(read(dir, 'a.txt')).toBe('v1\n')
    expect(fs.existsSync(path.join(dir, 'junk.txt'))).toBe(true)

    await call('git.discard', { cwd: dir, paths: ['junk.txt'], includeUntracked: true })
    expect(fs.existsSync(path.join(dir, 'junk.txt'))).toBe(false)

    const fresh = makeRepo()
    write(fresh, 'new.txt', 'n\n')
    git(fresh, ['add', 'new.txt'])
    await call('git.unstage', { cwd: fresh, paths: ['new.txt'] })
    status = await call<GitStatusResult>('git.status', { cwd: fresh })
    expect(status.files[0]).toMatchObject({ path: 'new.txt', index: '?' })
  }, 30_000)

  it('git.branches / git.switch / fetch / push / pull / --track', async () => {
    const dir = makeRepo()
    write(dir, 'a.txt', 'a\n')
    commitAll(dir, 'init')

    const branches = await call<{
      current: string | null
      local: Array<{ name: string; upstream?: string }>
      remote: Array<{ name: string }>
    }>('git.branches', { cwd: dir })
    expect(branches.current).toBe('main')
    expect(branches.local.map((item) => item.name)).toContain('main')
    expect(branches.local[0]?.upstream).toBeUndefined()

    await call('git.switch', { cwd: dir, branch: 'feature', create: true })
    expect((await call<GitStatusResult>('git.status', { cwd: dir })).branch).toBe('feature')
    expect((await call<{ current: string | null }>('git.branches', { cwd: dir })).current).toBe(
      'feature',
    )
    await call('git.switch', { cwd: dir, branch: 'main' })
    expect((await call<GitStatusResult>('git.status', { cwd: dir })).branch).toBe('main')

    const bare = tempDir('qn-git-bare-')
    git(bare, ['init', '-q', '--bare', '-b', 'main'])
    git(dir, ['remote', 'add', 'origin', bare])
    const pushed = await call<{ output: string }>('git.push', {
      cwd: dir,
      remote: 'origin',
      branch: 'main',
      setUpstream: true,
    })
    expect(typeof pushed.output).toBe('string')
    await call<{ output: string }>('git.fetch', { cwd: dir, remote: 'origin' })
    const afterFetch = await call<{
      local: Array<{ name: string; upstream?: string }>
      remote: Array<{ name: string }>
    }>('git.branches', { cwd: dir })
    expect(afterFetch.remote.map((item) => item.name)).toContain('origin/main')
    expect(afterFetch.local.find((item) => item.name === 'main')?.upstream).toBe('origin/main')
    await call<{ output: string }>('git.pull', { cwd: dir, remote: 'origin', branch: 'main' })

    git(dir, ['branch', 'topic'])
    await call('git.push', { cwd: dir, remote: 'origin', branch: 'topic' })
    await call('git.fetch', { cwd: dir, remote: 'origin' })
    git(dir, ['branch', '-D', 'topic'])
    await call('git.switch', { cwd: dir, branch: 'origin/topic' })
    expect((await call<GitStatusResult>('git.status', { cwd: dir })).branch).toBe('topic')
  }, 30_000)

  it('非仓库目录 → not_repo；空 message → params', async () => {
    const plain = tempDir('qn-git-plain-')
    await expect(call('git.status', { cwd: plain })).rejects.toMatchObject({ code: 'not_repo' })
    const dir = makeRepo()
    await expect(call('git.commit', { cwd: dir, message: '' })).rejects.toMatchObject({
      code: 'params',
    })
  }, 30_000)

  it.skipIf(process.platform !== 'win32')(
    'Windows 本机验收：中文名不转义、autocrlf=true 不整文件改动、混用斜杠/大小写/长路径',
    async () => {
      const dir = makeRepo()
      git(dir, ['config', 'core.autocrlf', 'true'])
      const chinese = '中文 文件.txt'
      write(dir, 'CaseFile.txt', Buffer.from('one\r\ntwo\r\nthree\r\n'))
      write(dir, chinese, Buffer.from('a\r\nb\r\n'))
      commitAll(dir, 'init')
      write(dir, 'CaseFile.txt', Buffer.from('one\r\nTWO\r\nthree\r\n'))
      write(dir, chinese, Buffer.from('a\r\nB\r\n'))

      const status = await call<GitStatusResult>('git.status', { cwd: dir })
      expect(status.files.map((item) => item.path)).toContain(chinese)
      expect(status.files.map((item) => item.path)).toContain('CaseFile.txt')

      // cwd 混用正斜杠并改变大小写，仍能定位同一个仓库。
      const mixedCwd = dir.replace(/\\/g, '/').toUpperCase()
      const mixedStatus = await call<GitStatusResult>('git.status', { cwd: mixedCwd })
      expect(mixedStatus.files).toHaveLength(status.files.length)

      // 文件名大小写不同由根相对路径归一修正，git pathspec 不会静默匹配不到。
      const diff = await call<{ diff: string; truncated: boolean }>('git.diff', {
        cwd: dir,
        path: path.join(dir, 'casefile.txt').replace(/\\/g, '/'),
      })
      expect(diff.diff).toContain('-two')
      expect(diff.diff).toContain('+TWO')
      expect(diff.diff).not.toContain('+one')
      expect(diff.truncated).toBe(false)

      const chineseDiff = await call<{ diff: string }>('git.diff', {
        cwd: dir,
        path: path.join(dir, chinese),
      })
      expect(chineseDiff.diff).toContain(chinese)
      expect(chineseDiff.diff).not.toContain('\\344')

      // \\?\ 长路径前缀的 cwd 也能跑 git 命令。
      const longCwd = `\\\\?\\${path.resolve(dir)}`
      const longStatus = await call<GitStatusResult>('git.status', { cwd: longCwd })
      expect(longStatus.root.replace(/\\/g, '/').toLowerCase()).toBe(
        path.resolve(dir).replace(/\\/g, '/').toLowerCase(),
      )
    },
    60_000,
  )
})
