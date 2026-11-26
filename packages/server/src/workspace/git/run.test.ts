import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GIT_GLOBAL_ARGS,
  GitRunError,
  gitCandidates,
  resetGitCommandCache,
  resolveGitExecutable,
  runGit,
  type GitResolveEnv,
} from './run'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-git-run-'))
  dirs.push(dir)
  return dir
}

/** 用 node 跑一个小脚本代替 git，验证执行器本身而不依赖仓库。 */
function fakeGit(source: string): { dir: string; file: string } {
  const dir = tempDir()
  const file = path.join(dir, 'fake.cjs')
  fs.writeFileSync(file, source, 'utf8')
  return { dir, file }
}

const nodeGit = (
  dir: string,
  file: string,
  opts: Parameters<typeof runGit>[2] = {},
): Promise<Awaited<ReturnType<typeof runGit>>> =>
  runGit(dir, [file], { gitPath: process.execPath, ...opts })

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('git 可执行文件解析（Windows）', () => {
  const env: GitResolveEnv = {
    platform: 'win32',
    pathValue: 'C:\\bin;C:\\Program Files\\Git\\cmd',
    delimiter: ';',
    home: 'C:\\Users\\u',
    localAppData: 'C:\\Users\\u\\AppData\\Local',
    programFiles: 'C:\\Program Files',
  }

  it('候选顺序：PATH → Program Files\\Git\\cmd → LOCALAPPDATA → 裸名字', () => {
    const candidates = gitCandidates(env)
    expect(candidates[0]).toBe('C:\\bin\\git.exe')
    expect(candidates).toContain('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(candidates).toContain(
      'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
    )
    expect(candidates.at(-1)).toBe('git')
    expect(new Set(candidates.map((item) => item.toLowerCase())).size).toBe(candidates.length)
  })

  it('存在性检查命中第一个文件；都不存在时退回裸名字', () => {
    expect(
      resolveGitExecutable(env, (file) => file === 'C:\\Program Files\\Git\\cmd\\git.exe'),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(resolveGitExecutable(env, () => false)).toBe('git')
  })

  it('全局 -c 参数不覆盖 autocrlf', () => {
    expect(GIT_GLOBAL_ARGS).toEqual([
      '-c',
      'core.quotepath=false',
      '-c',
      'core.longpaths=true',
    ])
    expect(GIT_GLOBAL_ARGS.join(' ')).not.toContain('autocrlf')
  })

  it('本机真实 git 带全局 -c 参数仍可执行', async () => {
    resetGitCommandCache()
    const dir = tempDir()
    const res = await runGit(dir, ['--version'])
    expect(res.stdout).toMatch(/git version/)
    expect(res.code).toBe(0)
  })
})

describe('runGit 执行器', () => {
  it('git 不存在（ENOENT）→ git_missing', async () => {
    const dir = tempDir()
    await expect(runGit(dir, ['--version'], { gitPath: 'qn-no-such-git-binary' })).rejects.toMatchObject(
      { code: 'git_missing' } satisfies Partial<GitRunError>,
    )
  })

  it('cwd 不存在 → not_repo', async () => {
    const { dir, file } = fakeGit('process.exit(0)')
    await expect(nodeGit(path.join(dir, 'missing'), file)).rejects.toMatchObject({
      code: 'not_repo',
    })
  })

  it('环境变量、stdin、允许的退出码', async () => {
    const { dir, file } = fakeGit(`
      const input = require('node:fs').readFileSync(0, 'utf8')
      process.stdout.write(JSON.stringify({
        input,
        prompt: process.env.GIT_TERMINAL_PROMPT,
        locks: process.env.GIT_OPTIONAL_LOCKS,
        locale: process.env.LC_ALL,
        ssh: process.env.GIT_SSH_COMMAND,
      }))
      process.stderr.write('warning\\n')
      process.exit(1)
    `)
    const res = await nodeGit(dir, file, {
      input: 'hello',
      okCodes: [1],
      readOnly: true,
    })
    expect(res.code).toBe(1)
    expect(res.stderr).toBe('warning\n')
    expect(JSON.parse(res.stdout)).toEqual({
      input: 'hello',
      prompt: '0',
      locks: '0',
      locale: 'C',
      ssh: 'ssh -o BatchMode=yes',
    })
  })

  it('写命令不加 GIT_OPTIONAL_LOCKS，已有 GIT_SSH_COMMAND 不被覆盖', async () => {
    const { dir, file } = fakeGit(
      "process.stdout.write(JSON.stringify({ locks: process.env.GIT_OPTIONAL_LOCKS ?? null, ssh: process.env.GIT_SSH_COMMAND }))",
    )
    const res = await nodeGit(dir, file, {
      env: { GIT_OPTIONAL_LOCKS: 'from-test', GIT_SSH_COMMAND: 'ssh -i key' },
    })
    expect(JSON.parse(res.stdout)).toEqual({ locks: 'from-test', ssh: 'ssh -i key' })
  })

  it('stdout 达到上限后截断并标记 truncated', async () => {
    const { dir, file } = fakeGit("process.stdout.write('x'.repeat(100))")
    const res = await nodeGit(dir, file, { maxStdout: 10 })
    expect(res.stdout).toBe('xxxxxxxxxx')
    expect(res.stdoutRaw).toHaveLength(10)
    expect(res.truncated).toBe(true)
    expect(res.timedOut).toBe(false)
  })

  it('认证失败 → auth_required，摘要不含 URL 凭据', async () => {
    const { dir, file } = fakeGit(
      "process.stderr.write(\"fatal: Authentication failed for 'https://u:pw@host/r.git'\\n\"); process.exit(128)",
    )
    await expect(nodeGit(dir, file)).rejects.toMatchObject({ code: 'auth_required' })
    try {
      await nodeGit(dir, file)
    } catch (err) {
      expect(err).toBeInstanceOf(GitRunError)
      expect((err as GitRunError).message).toContain('https://***@host/r.git')
      expect((err as GitRunError).message).not.toContain('pw@')
    }
  })

  it('not a git repository → not_repo', async () => {
    const { dir, file } = fakeGit(
      "process.stderr.write('fatal: not a git repository\\n'); process.exit(128)",
    )
    await expect(nodeGit(dir, file)).rejects.toMatchObject({ code: 'not_repo' })
  })

  it('超时终止进程 → git_failed', async () => {
    const { dir, file } = fakeGit('setTimeout(() => {}, 10000)')
    await expect(nodeGit(dir, file, { timeoutMs: 80 })).rejects.toMatchObject({
      code: 'git_failed',
      message: expect.stringContaining('超时'),
    })
  }, 10_000)
})
