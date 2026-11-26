import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizePathForCompare } from '../paths'
import { WorkspaceError } from '../registry'
import { classifyGitFailure, redactCredentials, type GitFailureCode } from './errors'

export const LOCAL_TIMEOUT_MS = 30_000
export const NETWORK_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024
export const DIFF_MAX_STDOUT = 4 * 1024 * 1024
export const SHOW_MAX_STDOUT = 2 * 1024 * 1024
const MAX_STDERR = 1024 * 1024

/** 中文路径不被转义、Windows 长路径可用；autocrlf 不覆盖，交给仓库自身配置。 */
export const GIT_GLOBAL_ARGS = ['-c', 'core.quotepath=false', '-c', 'core.longpaths=true'] as const

export interface GitResolveEnv {
  platform: string
  pathValue: string
  delimiter: string
  home: string
  programFiles?: string
  programFilesX86?: string
  localAppData?: string
}

export function defaultGitResolveEnv(): GitResolveEnv {
  return {
    platform: process.platform,
    pathValue: process.env['PATH'] ?? '',
    delimiter: path.delimiter,
    home: os.homedir(),
    ...(process.env['ProgramFiles'] ? { programFiles: process.env['ProgramFiles'] } : {}),
    ...(process.env['ProgramFiles(x86)']
      ? { programFilesX86: process.env['ProgramFiles(x86)'] }
      : {}),
    ...(process.env['LOCALAPPDATA'] ? { localAppData: process.env['LOCALAPPDATA'] } : {}),
  }
}

/** 解析顺序：PATH → Program Files\Git\cmd → %LOCALAPPDATA%\Programs\Git\cmd → 裸名字兜底。 */
export function gitCandidates(env: GitResolveEnv): string[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix
  const names = env.platform === 'win32' ? ['git.exe'] : ['git']
  const dirs = env.pathValue.split(env.delimiter).filter(Boolean)
  const extras =
    env.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\cmd',
          ...(env.programFiles ? [p.join(env.programFiles, 'Git', 'cmd')] : []),
          ...(env.programFilesX86 ? [p.join(env.programFilesX86, 'Git', 'cmd')] : []),
          ...(env.localAppData ? [p.join(env.localAppData, 'Programs', 'Git', 'cmd')] : []),
        ]
      : ['/usr/local/bin', p.join(env.home, '.local', 'bin')]
  const result: string[] = []
  const seen = new Set<string>()
  for (const dir of [...dirs, ...extras]) {
    for (const name of names) {
      const candidate = p.join(dir, name)
      const key = normalizePathForCompare(candidate, env.platform)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
    }
  }
  result.push('git')
  return result
}

function gitExists(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 只做文件存在性检查与解析，不调用 git（合规 §7 只针对 Agent，这里同样不下载/安装）。 */
export function resolveGitExecutable(
  env: GitResolveEnv = defaultGitResolveEnv(),
  exists: (file: string) => boolean = gitExists,
): string {
  for (const candidate of gitCandidates(env)) {
    // 裸名字交给 spawn 按 PATH 解析，不做文件检查。
    if (!/[\\/]/.test(candidate) || exists(candidate)) return candidate
  }
  return 'git'
}

let cachedGitCommand: string | undefined

export function resetGitCommandCache(): void {
  cachedGitCommand = undefined
}

function gitCommand(): string {
  cachedGitCommand ??= resolveGitExecutable()
  return cachedGitCommand
}

export interface RunGitOptions {
  /** 只读命令额外设置 GIT_OPTIONAL_LOCKS=0，避免刷新索引 */
  readOnly?: boolean
  timeoutMs?: number
  /** 视作成功的非 0 退出码 */
  okCodes?: number[]
  /** 通过 stdin 传入（commit -F -） */
  input?: string
  maxStdout?: number
  /** 测试可替换可执行文件 */
  gitPath?: string
  env?: NodeJS.ProcessEnv
}

export interface GitRunResult {
  stdout: string
  stdoutRaw: Buffer
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  truncated: boolean
  timedOut: boolean
  args: string[]
}

/** 带着原始输出的错误，便于 git.show / git.log 区分「对象不存在」「空仓库」。 */
export class GitRunError extends WorkspaceError {
  constructor(
    code: GitFailureCode,
    message: string,
    readonly result: GitRunResult,
  ) {
    super(code, message)
    this.name = 'GitRunError'
  }
}

function gitEnv(opts: RunGitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...opts.env,
  }
  if (opts.readOnly === true) env.GIT_OPTIONAL_LOCKS = '0'
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return env
}

/**
 * 统一的 git 执行器：不经 shell、限量收集输出、超时终止、按错误码分类。
 * 失败时抛 GitRunError（WorkspaceError 子类），daemon 会把 code 原样回给客户端。
 */
export async function runGit(
  cwd: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitRunResult> {
  const maxStdout = Math.max(1, opts.maxStdout ?? DEFAULT_MAX_STDOUT)
  const timeoutMs = opts.timeoutMs ?? LOCAL_TIMEOUT_MS
  const stdoutChunks: Buffer[] = []
  let stdoutSize = 0
  let truncated = false
  let stderrRaw: Buffer = Buffer.alloc(0)
  let spawnError: NodeJS.ErrnoException | null = null
  let timedOut = false

  const buildResult = (code: number | null, signal: NodeJS.Signals | null): GitRunResult => {
    const stdoutRaw = Buffer.concat(stdoutChunks)
    return {
      stdout: stdoutRaw.toString('utf8'),
      stdoutRaw,
      stderr: stderrRaw.toString('utf8'),
      code,
      signal,
      truncated,
      timedOut,
      args,
    }
  }

  // gitPath 是测试钩子（可用 node 脚本代替 git），此时不注入 git 专属的 -c 参数。
  const executable = opts.gitPath ?? gitCommand()
  const spawnArgs = opts.gitPath === undefined ? [...GIT_GLOBAL_ARGS, ...args] : args
  let child: ChildProcess
  try {
    child = spawn(executable, spawnArgs, {
      cwd,
      env: gitEnv(opts),
      shell: false,
      windowsHide: true,
    })
  } catch (err) {
    const result = buildResult(null, null)
    throw new GitRunError(
      'git_failed',
      redactCredentials(`无法启动 git: ${err instanceof Error ? err.message : String(err)}`),
      result,
    )
  }

  return new Promise<GitRunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    let settled = false
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = buildResult(code, signal)
      const failure = classifyGitFailure({
        args,
        cwd,
        spawnError: spawnError
          ? { code: spawnError.code, message: spawnError.message }
          : null,
        cwdMissing: spawnError ? !fs.existsSync(cwd) : false,
        timedOut,
        exitCode: code,
        signal,
        okCodes: opts.okCodes,
        stderr: result.stderr,
        stdout: result.stdout,
      })
      if (failure) reject(new GitRunError(failure.code, failure.message, result))
      else resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutSize >= maxStdout) {
        truncated = true
        return
      }
      const remaining = maxStdout - stdoutSize
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining))
        stdoutSize = maxStdout
        truncated = true
      } else {
        stdoutChunks.push(chunk)
        stdoutSize += chunk.length
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      // 只保留末尾：错误摘要取最后 20 行，防止恶意输出撑爆内存。
      stderrRaw = chunk.length >= MAX_STDERR
        ? chunk.subarray(chunk.length - MAX_STDERR)
        : Buffer.concat([stderrRaw, chunk]).subarray(-MAX_STDERR)
    })

    // 命令提前退出时写 stdin 会 EPIPE，不能让它变成未处理异常。
    child.stdin?.on('error', () => {})
    if (opts.input !== undefined) child.stdin?.end(Buffer.from(opts.input, 'utf8'))
    else child.stdin?.end()

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err
      // 部分平台的 spawn ENOENT 不触发 close，兜底结算避免请求挂住。
      setImmediate(() => settle(null, null))
    })

    child.on('close', (code, signal) => settle(code, signal))
  })
}

/** 所有 git.* 方法先取仓库根，后续命令都在根下执行，保证路径是根相对路径。 */
export async function gitRoot(cwd: string): Promise<string> {
  const res = await runGit(cwd, ['rev-parse', '--show-toplevel'], { readOnly: true })
  const root = res.stdout.trim()
  if (!root) throw new WorkspaceError('not_repo', `不是 git 仓库: ${cwd}`)
  return path.resolve(root)
}

/** 空仓库没有 HEAD：unstage / discard 需要走不同命令。 */
export async function hasHead(root: string): Promise<boolean> {
  const res = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
    readOnly: true,
    okCodes: [0, 1],
  })
  return res.code === 0 && res.stdout.trim().length > 0
}
