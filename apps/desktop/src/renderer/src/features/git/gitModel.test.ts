import { describe, expect, it } from 'vitest'
import type { GitFileStatus, GitStatusResult } from '@qn/protocol'
import {
  aheadBehindBadge,
  aheadBehindText,
  branchLabel,
  describeGitError,
  discardPrompt,
  filePaths,
  filterBranches,
  formatRelativeTime,
  groupStatusFiles,
  isAbsolutePath,
  isConflict,
  isUntracked,
  joinRepoPath,
  pathsFor,
  remoteCheckoutName,
  repoKey,
  shortHash,
  sameStatus,
  sameBranches,
  branchesStale,
  mergeLogFirstPage,
  statusInfo,
  statusLetter,
  stderrSummary,
  validateCommitMessage,
} from './gitModel'

const file = (path: string, index: string, worktree: string, extra: Partial<GitFileStatus> = {}): GitFileStatus => ({
  path,
  index,
  worktree,
  conflict: false,
  ...extra,
})

const now = new Date(2026, 10, 25, 12, 0, 0).getTime()
const DAY = 86_400_000

describe('repoKey', () => {
  it('按 targetId + cwd 分仓且不会因分隔符撞键', () => {
    expect(repoKey('local', '/a/b')).not.toBe(repoKey('local', '/a/b/c'))
    expect(repoKey('local', '/a/b')).not.toBe(repoKey('ssh-1', '/a/b'))
    expect(repoKey('a:b', '/c')).not.toBe(repoKey('a', 'b:/c'))
  })
})

describe('groupStatusFiles', () => {
  const status: GitStatusResult = {
    root: '/repo',
    branch: 'main',
    head: 'abc',
    ahead: 0,
    behind: 0,
    files: [
      file('both.ts', 'M', 'M'),
      file('staged.ts', 'A', '.'),
      file('dirty.ts', '.', 'M'),
      file('new.ts', '?', '?'),
      file('gone.ts', 'D', '.'),
      file('conflict.ts', 'U', 'U'),
      file('merged.ts', 'A', 'A'),
      file('ignored.log', '!', '!'),
      file('rename.ts', 'R', '.', { origPath: 'old.ts' }),
    ],
  }

  const groups = groupStatusFiles(status.files)

  it('冲突单独一组，其余按 XY 分入已暂存/未暂存', () => {
    expect(groups.conflicts.map((f) => f.path)).toEqual(['conflict.ts', 'merged.ts'])
    expect(groups.staged.map((f) => f.path)).toEqual([
      'both.ts', 'staged.ts', 'gone.ts', 'rename.ts',
    ])
    expect(groups.unstaged.map((f) => f.path)).toEqual(['both.ts', 'dirty.ts', 'new.ts'])
  })

  it('同一文件可同时出现在已暂存与未暂存，未跟踪只在未暂存', () => {
    expect(groups.staged.some((f) => f.path === 'both.ts')).toBe(true)
    expect(groups.unstaged.some((f) => f.path === 'both.ts')).toBe(true)
    expect(groups.staged.some((f) => f.path === 'new.ts')).toBe(false)
    expect(groups.unstaged.some((f) => f.path === 'new.ts')).toBe(true)
    expect(groups.conflicts.some((f) => f.path === 'conflict.ts')).toBe(true)
    expect(groups.staged.some((f) => f.path === 'conflict.ts')).toBe(false)
  })

  it('冲突标志、空格与未跟踪判定', () => {
    expect(isConflict(file('x', '.', 'U', { conflict: true }))).toBe(true)
    expect(isConflict(file('x', 'D', 'U'))).toBe(true)
    expect(isConflict(file('x', '.', 'M'))).toBe(false)
    expect(isUntracked(file('x', '?', '?'))).toBe(true)
    expect(isUntracked(file('x', '.', 'M'))).toBe(false)
  })
})

describe('状态字母', () => {
  it('字母 → 中文标签与颜色', () => {
    expect(statusInfo('M')).toEqual({ label: '修改', tone: 'warn' })
    expect(statusInfo('A')).toEqual({ label: '新增', tone: 'ok' })
    expect(statusInfo('D')).toEqual({ label: '删除', tone: 'danger' })
    expect(statusInfo('R')).toEqual({ label: '重命名', tone: 'accent' })
    expect(statusInfo('C')).toEqual({ label: '复制', tone: 'accent' })
    expect(statusInfo('U')).toEqual({ label: '冲突', tone: 'danger' })
    expect(statusInfo('?')).toEqual({ label: '未跟踪', tone: 'muted' })
    expect(statusInfo('T')).toEqual({ label: '类型变更', tone: 'warn' })
    expect(statusInfo('M ')).toEqual({ label: '修改', tone: 'warn' })
  })

  it('无变化与冲突组合码', () => {
    expect(statusInfo('.')).toEqual({ label: '无变化', tone: 'muted' })
    expect(statusInfo('')).toEqual({ label: '无变化', tone: 'muted' })
    expect(statusInfo('AU')).toEqual({ label: '冲突', tone: 'danger' })
    expect(statusInfo('DD')).toEqual({ label: '冲突', tone: 'danger' })
    expect(statusInfo('ZZ')).toEqual({ label: 'ZZ', tone: 'muted' })
  })

  it('按分组取对应字母', () => {
    const both = file('a.ts', 'M', 'M')
    expect(statusLetter(both, 'staged')).toBe('M')
    expect(statusLetter(both, 'unstaged')).toBe('M')
    expect(statusLetter(both, 'conflicts')).toBe('U')
    expect(statusLetter(file('b.ts', '.', '?'), 'unstaged')).toBe('?')
    expect(statusLetter(file('c.ts', '.', '.'), 'unstaged')).toBe('?')
  })

  it('重命名带上原路径供 git add / restore', () => {
    expect(filePaths(file('new.ts', 'R', '.', { origPath: 'old.ts' }))).toEqual(['old.ts', 'new.ts'])
    expect(filePaths(file('new.ts', 'M', 'M'))).toEqual(['new.ts'])
    expect(pathsFor([
      file('new.ts', 'R', '.', { origPath: 'old.ts' }),
      file('new.ts', 'M', 'M'),
      file('b.ts', '?', '?'),
    ])).toEqual(['old.ts', 'new.ts', 'b.ts'])
  })
})

describe('路径拼装', () => {
  it('POSIX 根与 Windows 根各自沿用分隔符', () => {
    expect(joinRepoPath('/home/u/repo', 'src/a.ts')).toBe('/home/u/repo/src/a.ts')
    expect(joinRepoPath('/home/u/repo/', './src\\a.ts')).toBe('/home/u/repo/src/a.ts')
    expect(joinRepoPath('C:\\work\\repo', 'src/a.ts')).toBe('C:\\work\\repo\\src\\a.ts')
    expect(joinRepoPath('C:/work/repo', 'src/a.ts')).toBe('C:/work/repo/src/a.ts')
    expect(joinRepoPath('', 'src/a.ts')).toBe('src/a.ts')
  })

  it('绝对路径原样返回', () => {
    expect(joinRepoPath('/repo', '/tmp/a.ts')).toBe('/tmp/a.ts')
    expect(joinRepoPath('C:\\repo', 'D:\\a.ts')).toBe('D:\\a.ts')
    expect(isAbsolutePath('\\\\server\\share\\a')).toBe(true)
  })
})

describe('ahead / behind', () => {
  it('中文文案与紧凑徽标', () => {
    expect(aheadBehindText(0, 0)).toBe('已与远端同步')
    expect(aheadBehindText(2, 0)).toBe('领先 2 个提交')
    expect(aheadBehindText(0, 3)).toBe('落后 3 个提交')
    expect(aheadBehindText(2, 3)).toBe('领先 2 个提交 · 落后 3 个提交')
    expect(aheadBehindBadge(0, 0)).toBe('')
    expect(aheadBehindBadge(2, 3)).toBe('↑2 ↓3')
    expect(aheadBehindText(-1, Number.NaN)).toBe('已与远端同步')
  })
})

describe('提交信息校验', () => {
  it('空白阻止提交', () => {
    expect(validateCommitMessage('')).toEqual({ ok: false, error: '请输入提交信息' })
    expect(validateCommitMessage('  \n  ')).toEqual({ ok: false, error: '请输入提交信息' })
  })

  it('首行超 72 字符只提示不阻止', () => {
    const result = validateCommitMessage('a'.repeat(73) + '\n\n正文')
    expect(result.ok).toBe(true)
    expect(result.warning).toContain('72')
    expect(validateCommitMessage('a'.repeat(72) + '\n第二行很长'.repeat(20))).toEqual({ ok: true })
    expect(validateCommitMessage('修复一个 bug')).toEqual({ ok: true })
  })
})

describe('相对时间', () => {
  it('刚刚 / 分钟前 / 小时前 / 昨天 / 天前 / 日期', () => {
    expect(formatRelativeTime(now - 20_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now + 60_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('3 分钟前')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatRelativeTime(now - DAY - 3_600_000, now)).toBe('昨天')
    expect(formatRelativeTime(now - 3 * DAY, now)).toBe('3 天前')
    expect(formatRelativeTime(new Date(2026, 9, 9).getTime(), now)).toBe('10/9')
    expect(formatRelativeTime(new Date(2025, 0, 3).getTime(), now)).toBe('2025/1/3')
    expect(formatRelativeTime(0, now)).toBe('')
    expect(formatRelativeTime(Number.NaN, now)).toBe('')
  })

  it('短 hash 与分支名', () => {
    expect(shortHash('abcdef123456')).toBe('abcdef1')
    expect(shortHash('abc', 10)).toBe('abc')
    expect(branchLabel('main')).toBe('main')
    expect(branchLabel(null)).toBe('（分离 HEAD）')
  })
})

describe('分支列表', () => {
  const local = [
    { name: 'main', head: 'a' },
    { name: 'feature/git', head: 'b', upstream: 'origin/main' },
  ]

  it('搜索忽略大小写并支持 upstream', () => {
    expect(filterBranches(local, 'GIT').map((b) => b.name)).toEqual(['feature/git'])
    expect(filterBranches(local, 'origin').map((b) => b.name)).toEqual(['feature/git'])
    expect(filterBranches(local, '  ').map((b) => b.name)).toEqual(['main', 'feature/git'])
    expect(filterBranches(local, 'zzz')).toEqual([])
  })

  it('远端分支去掉 remote 前缀', () => {
    expect(remoteCheckoutName('origin/feature/git')).toBe('feature/git')
    expect(remoteCheckoutName('upstream/main')).toBe('main')
    expect(remoteCheckoutName('main')).toBe('main')
  })
})

describe('放弃确认文案', () => {
  it('含未跟踪文件时明确提示将删除文件', () => {
    const text = discardPrompt([file('new.ts', '?', '?')])
    expect(text).toContain('将删除文件')
    expect(text).toContain('new.ts')
    expect(discardPrompt([file('a.ts', '.', 'M')])).toContain('不可撤销')
  })
})

describe('错误提示', () => {
  it('错误码 → 中文提示', () => {
    expect(describeGitError({ code: 'auth_required', message: 'x' }).message).toBe(
      '远端需要认证，请在远端配置 ssh-agent 或凭据助手',
    )
    expect(describeGitError({ code: 'not_repo', message: 'x' })).toEqual({
      code: 'not_repo',
      message: '当前目录不是 Git 仓库',
    })
    expect(describeGitError({ code: 'git_missing', message: 'x' }).message).toContain('安装 Git')
    expect(describeGitError({ code: 'not_connected', message: 'x' }).message).toContain('未连接')
  })

  it('git_failed 显示 stderr 摘要', () => {
    const info = describeGitError({ code: 'git_failed', message: 'fatal: not a git repo\nerror: push failed' })
    expect(info.code).toBe('git_failed')
    expect(info.message).toBe('Git 命令失败：fatal: not a git repo error: push failed')
    expect(describeGitError({ code: 'git_failed', message: '' }).message).toContain('Git 命令失败')
  })

  it('stderr 摘要遮盖凭据并限长', () => {
    expect(stderrSummary('https://user:pwd@host/repo failed')).toContain('***@')
    expect(stderrSummary('PASSWORD=abc123 token: xyz')).not.toContain('abc123')
    expect(stderrSummary('a'.repeat(400)).length).toBeLessThanOrEqual(241)
  })

  it('未知错误回退到原始信息', () => {
    expect(describeGitError(new Error('连接已断开')).message).toBe('连接已断开')
    expect(describeGitError(null, '刷新失败').message).toBe('刷新失败')
  })
})

describe('轮询比对', () => {
  const st = (files: GitFileStatus[] = []): GitStatusResult => ({
    root: '/r', branch: 'main', head: 'a', ahead: 0, behind: 0, files,
  })
  const f = (path: string, worktree = 'M'): GitFileStatus => ({ path, index: '.', worktree, conflict: false })

  it('sameStatus 按内容比较', () => {
    expect(sameStatus(st([f('a')]), st([f('a')]))).toBe(true)
    expect(sameStatus(st([f('a')]), st([f('a', 'D')]))).toBe(false)
    expect(sameStatus(st(), { ...st(), ahead: 1 })).toBe(false)
    expect(sameStatus(null, st())).toBe(false)
  })

  it('sameBranches / branchesStale', () => {
    const b = { current: 'main', local: [{ name: 'main', head: 'a' }], remote: [] }
    expect(sameBranches(b, { ...b, local: [{ name: 'main', head: 'a' }] })).toBe(true)
    expect(sameBranches(b, { ...b, local: [{ name: 'main', head: 'b' }] })).toBe(false)
    expect(branchesStale(st(), st([f('x')]))).toBe(false)
    expect(branchesStale(st(), { ...st(), head: 'b' })).toBe(true)
    expect(branchesStale(null, st())).toBe(true)
  })

  it('mergeLogFirstPage 首页一致时保留已分页列表', () => {
    const c = (hash: string) => ({ hash, parents: [], author: 'a', email: 'e', date: 0, subject: 's' })
    const prev = [c('1'), c('2'), c('3')]
    expect(mergeLogFirstPage(prev, [c('1'), c('2')])).toBeNull()
    expect(mergeLogFirstPage(prev, [c('0'), c('1')])).toEqual([c('0'), c('1')])
    expect(mergeLogFirstPage([], [])).toBeNull()
    expect(mergeLogFirstPage([c('1')], [c('1'), c('2')])).toHaveLength(2)
  })
})
