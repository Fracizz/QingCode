import { describe, expect, it } from 'vitest'
import {
  classifyGitFailure,
  isAuthError,
  isEmptyRepoError,
  isMissingObjectError,
  mergeOutput,
  redactCredentials,
  tailLines,
  type GitFailureInput,
} from './errors'

const failure = (overrides: Partial<GitFailureInput> = {}): GitFailureInput => ({
  args: ['status'],
  exitCode: 1,
  stderr: '',
  stdout: '',
  ...overrides,
})

describe('redactCredentials', () => {
  it('抹掉 URL 里的 user:password@（含整段 userinfo）', () => {
    expect(redactCredentials('fatal: https://alice:s3cr3t@git.example.com/repo.git failed')).toBe(
      'fatal: https://***@git.example.com/repo.git failed',
    )
    expect(redactCredentials('From ssh://bob:pw@host/x')).toBe('From ssh://***@host/x')
  })

  it('只有用户名的 URL 也抹掉（PAT 常放在用户名位置）', () => {
    expect(redactCredentials('https://ghp_token@github.com/o/r.git')).toBe(
      'https://***@github.com/o/r.git',
    )
  })

  it('多个 URL 全部处理，普通文本不变', () => {
    const text = 'a https://u:p@a.com/x b https://u2:p2@b.com/y\ncould not read Username'
    expect(redactCredentials(text)).toBe(
      'a https://***@a.com/x b https://***@b.com/y\ncould not read Username',
    )
    expect(redactCredentials('fatal: not a git repository')).toBe('fatal: not a git repository')
  })
})

describe('tailLines', () => {
  it('只保留末尾 20 行，去掉尾部空行', () => {
    const text = Array.from({ length: 25 }, (_, i) => `line-${i}`).join('\n') + '\n\n'
    expect(tailLines(text)).toBe(Array.from({ length: 20 }, (_, i) => `line-${i + 5}`).join('\n'))
  })

  it('CRLF 归一，空文本返回空', () => {
    expect(tailLines('a\r\nb\r\n')).toBe('a\nb')
    expect(tailLines('')).toBe('')
  })
})

describe('mergeOutput', () => {
  it('合并 stdout/stderr 并过滤凭据', () => {
    expect(mergeOutput(' ok \n', 'From https://u:p@host/r\n')).toBe(
      'ok\nFrom https://***@host/r',
    )
    expect(mergeOutput('', '')).toBe('')
  })
})

describe('错误分类纯函数', () => {
  it('成功与允许的退出码都返回 null', () => {
    expect(classifyGitFailure(failure({ exitCode: 0 }))).toBeNull()
    expect(classifyGitFailure(failure({ exitCode: 1, okCodes: [0, 1] }))).toBeNull()
  })

  it('spawn ENOENT 区分 git 缺失与目录不存在', () => {
    expect(
      classifyGitFailure(failure({ spawnError: { code: 'ENOENT' }, cwdMissing: false })),
    ).toMatchObject({ code: 'git_missing' })
    expect(
      classifyGitFailure(
        failure({ spawnError: { code: 'ENOENT' }, cwdMissing: true, cwd: '/gone' }),
      ),
    ).toMatchObject({ code: 'not_repo' })
    expect(
      classifyGitFailure(failure({ spawnError: { code: 'EACCES', message: 'denied' } })),
    ).toMatchObject({ code: 'git_failed' })
  })

  it('超时与信号终止归为 git_failed', () => {
    expect(classifyGitFailure(failure({ timedOut: true, args: ['fetch'] }))).toMatchObject({
      code: 'git_failed',
      message: expect.stringContaining('超时'),
    })
    expect(classifyGitFailure(failure({ exitCode: null, signal: 'SIGKILL' }))).toMatchObject({
      code: 'git_failed',
      message: expect.stringContaining('SIGKILL'),
    })
  })

  it('not a git repository → not_repo（优先于认证错误）', () => {
    expect(
      classifyGitFailure(failure({ stderr: 'fatal: not a git repository (or any parent)' })),
    ).toMatchObject({ code: 'not_repo' })
    expect(
      classifyGitFailure(
        failure({ stderr: 'fatal: not a git repository\nAuthentication failed' }),
      ),
    ).toMatchObject({ code: 'not_repo' })
  })

  it.each([
    'fatal: Authentication failed for https://host/x',
    'Permission denied (publickey).',
    "fatal: could not read Username for 'https://host': terminal prompts disabled",
    'fatal: terminal prompts disabled',
  ])('认证失败 → auth_required: %s', (stderr) => {
    expect(isAuthError(stderr)).toBe(true)
    expect(classifyGitFailure(failure({ stderr }))).toMatchObject({ code: 'auth_required' })
  })

  it('其他失败：stderr 末尾 20 行，且不泄漏凭据', () => {
    const stderr =
      Array.from({ length: 24 }, (_, i) => `line-${i}`).join('\n') +
      '\nfatal: https://u:p@host/r.git failed'
    const result = classifyGitFailure(failure({ exitCode: 128, stderr }))
    expect(result?.code).toBe('git_failed')
    expect(result?.message.split('\n')).toHaveLength(20)
    expect(result?.message).toContain('fatal: https://***@host/r.git failed')
    expect(result?.message).not.toContain('u:p@')
    expect(result?.message).not.toContain('line-0')
  })

  it('stderr 为空时退回 stdout 摘要', () => {
    expect(classifyGitFailure(failure({ stdout: 'nothing to commit', stderr: '' }))).toMatchObject(
      { code: 'git_failed', message: 'nothing to commit' },
    )
    expect(classifyGitFailure(failure({ stderr: '' }))).toMatchObject({ code: 'git_failed' })
  })
})

describe('特殊失败识别', () => {
  it('git show 对象/路径不存在', () => {
    expect(isMissingObjectError("fatal: path 'x' does not exist in 'HEAD'")).toBe(true)
    expect(isMissingObjectError("fatal: invalid object name 'nosuch'.")).toBe(true)
    expect(isMissingObjectError('fatal: bad revision HEAD~9')).toBe(true)
    expect(isMissingObjectError('fatal: not a git repository')).toBe(false)
  })

  it('空仓库 git log', () => {
    expect(
      isEmptyRepoError("fatal: your current branch 'main' does not have any commits yet"),
    ).toBe(true)
    expect(isEmptyRepoError('fatal: Authentication failed')).toBe(false)
  })
})
