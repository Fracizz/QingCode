import type { WorkspaceErrorCode } from '@qn/protocol'

export type GitFailureCode = Extract<
  WorkspaceErrorCode,
  'git_missing' | 'not_repo' | 'auth_required' | 'git_failed'
>

export interface GitFailureInput {
  args: string[]
  cwd?: string
  spawnError?: { code?: string; message?: string } | null
  /** 由执行器在 spawn 失败时探测；保持本函数无 IO */
  cwdMissing?: boolean
  timedOut?: boolean
  exitCode: number | null
  signal?: string | null
  /** 视作成功的非 0 退出码，如 diff --no-index 的 1 */
  okCodes?: number[]
  stderr: string
  stdout: string
}

export interface GitFailure {
  code: GitFailureCode
  message: string
}

const NOT_REPO = /not a git repository/i

const AUTH_PATTERNS = [
  /authentication failed/i,
  /permission denied \(publickey/i,
  /could not read username/i,
  /terminal prompts disabled/i,
]

const MISSING_OBJECT_PATTERNS = [
  /does not exist in/i,
  /exists on disk, but not in/i,
  /invalid object name/i,
  /not a valid object name/i,
  /bad revision/i,
  /unknown revision/i,
]

const EMPTY_REPO_PATTERNS = [
  /does not have any commits yet/i,
  /bad default revision/i,
  /unknown revision or path not in the working tree/i,
]

// git 回显的远端 URL 可能带 user:password@，摘要里必须抹掉整段 userinfo（PAT 常放在用户名位置）。
const URL_USERINFO = /([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi

export function redactCredentials(text: string): string {
  return text.replace(URL_USERINFO, (_all, scheme: string) => `${scheme}***@`)
}

export function tailLines(text: string, max = 20): string {
  if (!text) return ''
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && (lines.at(-1) ?? '').length === 0) lines.pop()
  return lines.slice(-Math.max(1, max)).join('\n')
}

/** fetch/pull/push 的输出合并：进度在 stderr，结果在 stdout，都要过滤凭据。 */
export function mergeOutput(stdout: string, stderr: string): string {
  return [redactCredentials(stdout).trim(), redactCredentials(stderr).trim()]
    .filter((part) => part.length > 0)
    .join('\n')
}

export function isAuthError(stderr: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(stderr))
}

/** git show 读不存在的 ref/路径时，按协议返回 exists:false 而不是错误。 */
export function isMissingObjectError(stderr: string): boolean {
  return MISSING_OBJECT_PATTERNS.some((pattern) => pattern.test(stderr))
}

/** 空仓库的 git log 会直接 fatal，协议要求返回空数组。 */
export function isEmptyRepoError(stderr: string): boolean {
  return EMPTY_REPO_PATTERNS.some((pattern) => pattern.test(stderr))
}

function summarize(input: GitFailureInput): string {
  const text =
    tailLines(redactCredentials(input.stderr)) || tailLines(redactCredentials(input.stdout))
  // i18n-ignore: 按实际取值在词典登记整句
  return text || `git 命令失败（退出码 ${input.exitCode ?? '未知'}）`
}

/** 纯函数：把一次 git 调用的结果映射为统一错误码；null 表示成功。 */
export function classifyGitFailure(input: GitFailureInput): GitFailure | null {
  if (input.spawnError) {
    if (input.cwdMissing) {
      return { code: 'not_repo', message: `目录不存在: ${input.cwd ?? ''}` }
    }
    if (input.spawnError.code === 'ENOENT') {
      return { code: 'git_missing', message: '目标机未安装 git，或 git 不在 PATH 中' }
    }
    return {
      code: 'git_failed',
      // i18n-ignore: 按实际取值在词典登记整句
      message: redactCredentials(`无法启动 git: ${input.spawnError.message ?? '未知错误'}`),
    }
  }

  if (input.timedOut) {
    return { code: 'git_failed', message: `git ${input.args[0] ?? ''} 执行超时` }
  }

  const { exitCode } = input
  if (exitCode === 0 || (exitCode !== null && (input.okCodes ?? []).includes(exitCode))) {
    return null
  }
  if (exitCode === null) {
    return {
      code: 'git_failed',
      message: `git 进程被终止${input.signal ? ` (${input.signal})` : ''}`,
    }
  }

  if (NOT_REPO.test(input.stderr)) {
    return { code: 'not_repo', message: tailLines(redactCredentials(input.stderr)) || '不是 git 仓库' }
  }
  if (isAuthError(input.stderr)) {
    return {
      code: 'auth_required',
      message: tailLines(redactCredentials(input.stderr)) || 'git 认证失败，请在目标机配置凭据',
    }
  }
  return { code: 'git_failed', message: summarize(input) }
}
