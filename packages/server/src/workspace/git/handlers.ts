import fs from 'node:fs'
import path from 'node:path'
import type { GitBranch, GitCommit, GitStatusResult } from '@qn/protocol'
import { WorkspaceError } from '../registry'
import { isEmptyRepoError, isMissingObjectError, mergeOutput } from './errors'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranchRefs,
  parseLog,
  parseNameStatus,
  parseStatus,
  splitNul,
} from './parse'
import {
  canonicalizeRepoRelative,
  needCaseCanonicalization,
  planSwitch,
  toRepoRelative,
} from './pure'
import {
  DIFF_MAX_STDOUT,
  GitRunError,
  NETWORK_TIMEOUT_MS,
  SHOW_MAX_STDOUT,
  gitRoot,
  hasHead,
  runGit,
  type RunGitOptions,
} from './run'

type Params = Record<string, unknown>

function requireString(params: Params, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceError('params', `${key} 必须是非空字符串`)
  }
  return value
}

function optionalString(params: Params, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceError('params', `${key} 必须是非空字符串`)
  }
  return value
}

function optionalBool(params: Params, key: string): boolean {
  const value = params[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new WorkspaceError('params', `${key} 必须是布尔值`)
  return value
}

function optionalInt(params: Params, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new WorkspaceError('params', `${key} 必须是整数`)
  }
  return value
}

function requireCwd(params: Params): string {
  const cwd = requireString(params, 'cwd')
  if (!path.isAbsolute(cwd)) throw new WorkspaceError('params', 'cwd 必须是绝对路径')
  return cwd
}

function requirePaths(params: Params): string[] {
  const value = params.paths
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new WorkspaceError('params', 'paths 必须是非空字符串数组')
  }
  return value as string[]
}

/** ref / 分支 / 远端名要放在选项位置之前，禁止以 '-' 开头冒充选项。 */
function safeRef(value: string, label: string): string {
  if (value.startsWith('-') || value.includes('\0')) {
    throw new WorkspaceError('params', `${label} 非法`)
  }
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

/** 仓库根相对路径；Windows 上再按磁盘真实大小写归一，避免 git pathspec 静默匹配不到。 */
function toRel(root: string, value: string): string {
  const rel = toRepoRelative(root, value)
  if (!needCaseCanonicalization(root)) return rel
  return canonicalizeRepoRelative(root, rel, (dir) => fs.readdirSync(dir))
}

function repoPaths(root: string, values: string[]): string[] {
  return values.map((value) => toRel(root, value))
}

/** 用 ls-files 取「git 已知」的路径，避免把未跟踪路径传给 restore 导致整批失败。 */
async function listTracked(root: string, rels: string[]): Promise<string[]> {
  const res = await runGit(root, ['ls-files', '-z', '--', ...rels], { readOnly: true })
  return splitNul(res.stdout)
}

/** -z + --untracked-files=all 列出每个未跟踪文件，而不是目录。 */
async function listUntracked(root: string, rels: string[]): Promise<string[]> {
  const res = await runGit(
    root,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...rels],
    { readOnly: true },
  )
  return parseStatus(res.stdout)
    .files.filter((file) => file.index === '?')
    .map((file) => file.path)
}

async function isUntrackedFile(root: string, rel: string): Promise<boolean> {
  const untracked = await listUntracked(root, [rel])
  if (!untracked.includes(rel)) return false
  try {
    return fs.statSync(path.join(root, rel)).isFile()
  } catch {
    return false
  }
}

export async function gitStatus(params: Params): Promise<GitStatusResult> {
  const root = await gitRoot(requireCwd(params))
  const res = await runGit(
    root,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    { readOnly: true },
  )
  return { root, ...parseStatus(res.stdout) }
}

export async function gitDiff(params: Params): Promise<{ diff: string; truncated: boolean }> {
  const root = await gitRoot(requireCwd(params))
  const commit = optionalString(params, 'commit')
  const staged = optionalBool(params, 'staged')
  const contextLines = optionalInt(params, 'contextLines')
  const pathValue = optionalString(params, 'path')
  const rel = pathValue === undefined ? undefined : toRel(root, pathValue)
  const contextArg = contextLines === undefined ? [] : [`-U${clamp(contextLines, 0, 10_000)}`]
  const opts: RunGitOptions = { readOnly: true, maxStdout: DIFF_MAX_STDOUT }
  let args: string[]

  if (commit !== undefined) {
    args = [
      'show',
      '--format=',
      ...contextArg,
      safeRef(commit, 'commit'),
      ...(rel ? ['--', rel] : []),
    ]
  } else if (rel !== undefined && !staged && (await isUntrackedFile(root, rel))) {
    // 未跟踪文件不在索引里，git diff 看不到它；用 --no-index 与空设备对比。
    args = ['diff', '--no-index', ...contextArg, nullDevice(), rel]
    opts.okCodes = [0, 1]
  } else {
    args = [
      'diff',
      ...(staged ? ['--cached'] : []),
      ...contextArg,
      ...(rel ? ['--', rel] : []),
    ]
  }

  const res = await runGit(root, args, opts)
  return { diff: res.stdout, truncated: res.truncated }
}

export async function gitShow(
  params: Params,
): Promise<{ content: string; binary: boolean; exists: boolean }> {
  const root = await gitRoot(requireCwd(params))
  const rel = toRel(root, requireString(params, 'path'))
  const ref = safeRef(optionalString(params, 'ref') ?? 'HEAD', 'ref')
  try {
    const res = await runGit(root, ['show', `${ref}:${rel}`], {
      readOnly: true,
      maxStdout: SHOW_MAX_STDOUT,
    })
    if (res.stdoutRaw.includes(0)) return { content: '', binary: true, exists: true }
    return { content: res.stdout, binary: false, exists: true }
  } catch (err) {
    if (err instanceof GitRunError && isMissingObjectError(err.result.stderr)) {
      return { content: '', binary: false, exists: false }
    }
    throw err
  }
}

export async function gitStage(params: Params): Promise<Record<string, never>> {
  const root = await gitRoot(requireCwd(params))
  const rels = repoPaths(root, requirePaths(params))
  await runGit(root, ['add', '--', ...rels])
  return {}
}

export async function gitUnstage(params: Params): Promise<Record<string, never>> {
  const root = await gitRoot(requireCwd(params))
  const rels = repoPaths(root, requirePaths(params))
  const tracked = await listTracked(root, rels)
  if (tracked.length === 0) return {}
  // 空仓库没有 HEAD，restore --staged 会失败，只能用 rm --cached（-f 兼容已暂存的新文件）。
  const args = (await hasHead(root))
    ? ['restore', '--staged', '--', ...tracked]
    : ['rm', '--cached', '-f', '--', ...tracked]
  await runGit(root, args)
  return {}
}

export async function gitDiscard(params: Params): Promise<Record<string, never>> {
  const root = await gitRoot(requireCwd(params))
  const rels = repoPaths(root, requirePaths(params))
  const includeUntracked = optionalBool(params, 'includeUntracked')
  const tracked = await listTracked(root, rels)
  if (tracked.length > 0) {
    const source = (await hasHead(root)) ? ['--source=HEAD'] : []
    await runGit(root, ['restore', '--worktree', ...source, '--', ...tracked])
  }
  if (includeUntracked) {
    const untracked = await listUntracked(root, rels)
    if (untracked.length > 0) await runGit(root, ['clean', '-f', '--', ...untracked])
  }
  return {}
}

export async function gitCommit(params: Params): Promise<{ commit: string }> {
  const root = await gitRoot(requireCwd(params))
  const message = requireString(params, 'message')
  if (!message.trim()) throw new WorkspaceError('params', '提交信息不能为空')
  const amend = optionalBool(params, 'amend')
  await runGit(root, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message })
  const res = await runGit(root, ['rev-parse', 'HEAD'], { readOnly: true })
  return { commit: res.stdout.trim() }
}

export async function gitBranches(
  params: Params,
): Promise<{ current: string | null; local: GitBranch[]; remote: GitBranch[] }> {
  const root = await gitRoot(requireCwd(params))
  const res = await runGit(
    root,
    ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'],
    { readOnly: true },
  )
  const parsed = parseBranchRefs(res.stdout)
  let current = parsed.current
  if (current === null) {
    // 空仓库没有任何 ref，此时仍应报出 HEAD 指向的分支名。
    const sym = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      readOnly: true,
      okCodes: [0, 1],
    })
    const name = sym.stdout.trim()
    if (name) current = name
  }
  return { current, local: parsed.local, remote: parsed.remote }
}

export async function gitSwitch(params: Params): Promise<Record<string, never>> {
  const root = await gitRoot(requireCwd(params))
  const branch = safeRef(requireString(params, 'branch'), 'branch')
  const create = optionalBool(params, 'create')
  const res = await runGit(
    root,
    ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'],
    { readOnly: true },
  )
  await runGit(root, planSwitch(branch, create, parseBranchRefs(res.stdout)).args)
  return {}
}

async function remoteCommand(
  params: Params,
  kind: 'fetch' | 'pull' | 'push',
): Promise<{ output: string }> {
  const root = await gitRoot(requireCwd(params))
  const remote = optionalString(params, 'remote')
  const branch = optionalString(params, 'branch')
  const setUpstream = optionalBool(params, 'setUpstream')
  const safeRemote = remote === undefined ? undefined : safeRef(remote, 'remote')
  const safeBranch = branch === undefined ? undefined : safeRef(branch, 'branch')
  // 只给 branch 时补 origin，否则 git 会把分支名当成 remote。
  const remoteArg =
    safeRemote !== undefined ? [safeRemote] : safeBranch !== undefined ? ['origin'] : []
  const branchArg = safeBranch === undefined ? [] : [safeBranch]
  let args: string[]
  if (kind === 'fetch') {
    args = ['fetch', '--prune', ...remoteArg]
  } else if (kind === 'pull') {
    args = ['pull', '--ff-only', ...remoteArg, ...branchArg]
  } else {
    args = ['push', ...(setUpstream ? ['-u'] : []), ...remoteArg, ...branchArg]
  }
  const res = await runGit(root, args, { timeoutMs: NETWORK_TIMEOUT_MS })
  return { output: mergeOutput(res.stdout, res.stderr) }
}

export async function gitFetch(params: Params): Promise<{ output: string }> {
  return remoteCommand(params, 'fetch')
}

export async function gitPull(params: Params): Promise<{ output: string }> {
  return remoteCommand(params, 'pull')
}

export async function gitPush(params: Params): Promise<{ output: string }> {
  return remoteCommand(params, 'push')
}

export async function gitLog(params: Params): Promise<{ commits: GitCommit[] }> {
  const root = await gitRoot(requireCwd(params))
  const limit = clamp(optionalInt(params, 'limit') ?? 50, 1, 500)
  const skip = Math.max(0, optionalInt(params, 'skip') ?? 0)
  const pathValue = optionalString(params, 'path')
  const rel = pathValue === undefined ? undefined : toRel(root, pathValue)
  const args = [
    'log',
    `--format=${LOG_FORMAT}`,
    '-n',
    String(limit),
    '--skip',
    String(skip),
    ...(rel ? ['--', rel] : []),
  ]
  try {
    const res = await runGit(root, args, { readOnly: true })
    return { commits: parseLog(res.stdout) }
  } catch (err) {
    if (err instanceof GitRunError && isEmptyRepoError(err.result.stderr)) {
      return { commits: [] }
    }
    throw err
  }
}

export async function gitCommitFiles(
  params: Params,
): Promise<{ files: Array<{ path: string; origPath?: string; status: string }> }> {
  const root = await gitRoot(requireCwd(params))
  const commit = safeRef(requireString(params, 'commit'), 'commit')
  const res = await runGit(
    root,
    ['show', '--name-status', '-z', '--format=', '-M', '--root', commit],
    { readOnly: true },
  )
  return { files: parseNameStatus(res.stdout) }
}
