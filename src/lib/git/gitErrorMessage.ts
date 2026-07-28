export type GitPullErrorI18n = {
  key: string
  params?: Record<string, string | number>
}

export type ScmErrorContext = 'pull' | 'switch' | 'push' | 'fetch' | 'generic'

export type ScmErrorDisplay = {
  summaryKey: string
  summaryParams?: Record<string, string | number>
  files: string[]
  /** When true, `summaryKey` is already user-facing text (do not run through `t`). */
  literal?: boolean
}

const SCM_ERROR_PREFIXES = [
  /^(?:拉取失败[：:]\s*)+/u,
  /^(?:Git 拉取失败[：:]\s*)+/iu,
  /^(?:Git pull failed[：:]\s*)+/iu,
  /^(?:切换 Git 分支失败[：:]\s*)+/u,
  /^(?:切换分支失败[：:]\s*)+/u,
  /^(?:Git switch failed[：:]\s*)+/iu,
  /^(?:推送失败[：:]\s*)+/u,
  /^(?:Git 推送失败[：:]\s*)+/iu,
  /^(?:检查更新失败[：:]\s*)+/u,
]

/** Strip repeated UI / Rust prefixes and fetch progress noise. */
export function normalizeGitPullErrorRaw(raw: string): string {
  return normalizeGitErrorRaw(raw)
}

export function normalizeGitErrorRaw(raw: string): string {
  let text = raw.trim()
  for (let i = 0; i < 4; i++) {
    let next = text
    for (const prefix of SCM_ERROR_PREFIXES) {
      next = next.replace(prefix, '').trim()
    }
    if (next === text) break
    text = next
  }
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (/^https?:\/\//i.test(trimmed)) return false
      if (/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i.test(trimmed)) return false
      if (/^Updating [0-9a-f]{7,40}/i.test(trimmed)) return false
      if (/^From https?:\/\//i.test(trimmed)) return false
      if (/^remote:\s/i.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

function parseOverwrittenFileBlock(block: string): string[] {
  return block
    .split('\n')
    .map(line => line.replace(/^\t+/, '').trim())
    .filter(Boolean)
}

/** Extract paths from git "local changes would be overwritten" errors. */
export function extractGitOverwrittenFiles(text: string): string[] {
  const patterns = [
    /local changes to the following files would be overwritten by merge:\s*([\s\S]*?)(?:\nPlease commit|\nAborting|$)/i,
    /local changes to the following files would be overwritten by checkout:\s*([\s\S]*?)(?:\nPlease commit|\nAborting|$)/i,
    /您对下列文件的本地更改将被合并操作覆盖：\s*([\s\S]*?)(?:\n请提交|\nAborting|$)/u,
    /您对下列文件的本地修改将被检出操作覆盖：\s*([\s\S]*?)(?:\n请提交|\nAborting|$)/u,
  ]
  for (const pattern of patterns) {
    const block = pattern.exec(text)?.[1]
    if (block) {
      const files = parseOverwrittenFileBlock(block)
      if (files.length > 0) return files
    }
  }
  return []
}

export function formatGitChangedFileList(files: string[], maxShown = 3): string {
  if (files.length === 0) return ''
  if (files.length === 1) return files[0]
  const head = files.slice(0, maxShown).join('、')
  if (files.length <= maxShown) return head
  return `${head} 等 ${files.length} 个文件`
}

function lastMeaningfulGitLine(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const errLine = [...lines]
    .reverse()
    .find(line => /^error:/i.test(line) || /失败/u.test(line) || /fatal:/i.test(line))
  const candidate = errLine ?? lines[lines.length - 1] ?? text
  return candidate.replace(/^(?:error|fatal):\s*/i, '').trim()
}

function scmActionLabel(context: ScmErrorContext): { fail: string; action: string } {
  switch (context) {
    case 'switch':
      return { fail: '切换分支失败', action: '切换' }
    case 'push':
      return { fail: '推送失败', action: '推送' }
    case 'fetch':
      return { fail: '检查更新失败', action: '检查更新' }
    case 'pull':
      return { fail: '拉取失败', action: '拉取' }
    default:
      return { fail: '操作失败', action: '继续' }
  }
}

function inferScmErrorContext(raw: string): ScmErrorContext {
  if (/切换.*分支/u.test(raw) || /checkout/i.test(raw)) return 'switch'
  if (/推送/u.test(raw) || /push/i.test(raw)) return 'push'
  if (/检查更新|fetch/i.test(raw)) return 'fetch'
  if (/拉取|pull/i.test(raw)) return 'pull'
  return 'generic'
}

/** Map raw git failure text to a concise i18n key + params. */
export function gitScmErrorI18n(raw: string, context: ScmErrorContext = 'generic'): GitPullErrorI18n {
  const text = normalizeGitErrorRaw(raw)
  const lower = text.toLowerCase()
  const { fail, action } = scmActionLabel(context)

  const overwritten = extractGitOverwrittenFiles(text)
  if (
    overwritten.length > 0 ||
    lower.includes('would be overwritten by merge') ||
    lower.includes('would be overwritten by checkout') ||
    text.includes('本地更改将被合并操作覆盖') ||
    text.includes('本地修改将被检出操作覆盖')
  ) {
    if (overwritten.length === 1) {
      return {
        key: `${fail}：本地修改「{file}」尚未提交，请先提交或暂存后再${action}`,
        params: { file: overwritten[0] },
      }
    }
    const files = formatGitChangedFileList(overwritten)
    return {
      key: `${fail}：本地有未提交修改（{files}），请先提交或暂存后再${action}`,
      params: { files: files || '…' },
    }
  }

  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('permission denied') ||
    text.includes('认证失败') ||
    text.includes('权限被拒绝')
  ) {
    return { key: `${fail}：远程认证失败，请检查凭据或 SSH 密钥` }
  }

  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('failed to connect') ||
    lower.includes('unable to access') ||
    text.includes('无法连接')
  ) {
    return { key: `${fail}：无法连接远程仓库，请检查网络或远程地址` }
  }

  const detail = lastMeaningfulGitLine(text)
  if (!detail) {
    return { key: `${fail}：操作已取消` }
  }
  const clipped = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail
  return { key: `${fail}：{detail}`, params: { detail: clipped } }
}

export function parseScmErrorDisplay(raw: string, context?: ScmErrorContext): ScmErrorDisplay {
  if (/提交成功，但|提交失败：|提交信息已保留/u.test(raw)) {
    return { summaryKey: raw, files: [], literal: true }
  }
  const resolvedContext = context ?? inferScmErrorContext(raw)
  const i18n = gitScmErrorI18n(raw, resolvedContext)
  return {
    summaryKey: i18n.key,
    summaryParams: i18n.params,
    files: extractGitOverwrittenFiles(normalizeGitErrorRaw(raw)),
  }
}

/** Map raw git pull failure text to a concise i18n key + params. */
export function gitPullErrorI18n(raw: string): GitPullErrorI18n {
  return gitScmErrorI18n(raw, 'pull')
}

export function gitSwitchErrorI18n(raw: string): GitPullErrorI18n {
  return gitScmErrorI18n(raw, 'switch')
}

export type GitPushErrorKind =
  | 'behind-remote'
  | 'auth-failed'
  | 'no-upstream'
  | 'no-remote'
  | 'network'
  | 'unknown'

export const GIT_PUSH_ERROR_MESSAGE_KEYS: Record<GitPushErrorKind, string> = {
  'behind-remote': '远程分支有新的提交，请先点击「从远程拉取」同步后再推送',
  'auth-failed': '远程认证失败，请检查账号、密码或访问令牌',
  'no-upstream': '当前分支未配置上游远程分支，请先设置 upstream',
  'no-remote': '未配置远程仓库，请先添加 remote',
  network: '无法连接远程仓库，请检查网络或远程地址',
  unknown: '推送被拒绝，请检查远程分支状态后重试',
}

const PUSH_ERROR_PREFIX_RE =
  /^(?:Error:\s*)?(?:推送失败：\s*)?(?:Git 推送失败：\s*)+/i

export function classifyGitPushError(raw: string): GitPushErrorKind {
  const text = raw.toLowerCase()
  if (
    text.includes('fetch first') ||
    text.includes('non-fast-forward') ||
    text.includes('remote contains work that you do not have locally') ||
    /!\s*\[rejected\]/.test(raw)
  ) {
    return 'behind-remote'
  }
  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('permission denied') ||
    text.includes('access rights') ||
    text.includes('认证失败') ||
    /\b401\b/.test(text) ||
    /\b403\b/.test(text)
  ) {
    return 'auth-failed'
  }
  if (
    text.includes('no upstream branch') ||
    text.includes('set-upstream') ||
    text.includes('has no upstream branch')
  ) {
    return 'no-upstream'
  }
  if (
    text.includes('no configured push destination') ||
    text.includes("'origin' does not appear to be a git repository") ||
    text.includes('could not read from remote repository')
  ) {
    return text.includes('authentication') || text.includes('permission')
      ? 'auth-failed'
      : 'no-remote'
  }
  if (
    text.includes('could not resolve host') ||
    text.includes('connection refused') ||
    text.includes('connection timed out') ||
    text.includes('failed to connect') ||
    text.includes('network is unreachable')
  ) {
    return 'network'
  }
  return 'unknown'
}

export function resolveGitPushErrorMessage(
  raw: string,
  translate: (key: string) => string,
): string {
  const kind = classifyGitPushError(raw)
  if (kind !== 'unknown') return translate(GIT_PUSH_ERROR_MESSAGE_KEYS[kind])
  const i18n = gitScmErrorI18n(raw, 'push')
  return translate(i18n.key, i18n.params)
}
