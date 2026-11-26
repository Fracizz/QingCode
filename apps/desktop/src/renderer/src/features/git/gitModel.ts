import type { GitBranch, GitFileStatus } from '@qn/protocol'

// Git 面板的展示语义与路径换算全部收在这里，避免组件里散落 porcelain 字母判断。

export type GitGroupKey = 'conflicts' | 'staged' | 'unstaged'
export type StatusTone = 'muted' | 'accent' | 'ok' | 'warn' | 'danger'
export type StatusInfo = { label: string; tone: StatusTone }

export const gitGroups: ReadonlyArray<{ key: GitGroupKey; label: string }> = [
  { key: 'conflicts', label: '冲突' },
  { key: 'staged', label: '已暂存' },
  { key: 'unstaged', label: '未暂存' },
]

/** 按 targetId + cwd 分仓；JSON 数组编码避免路径里出现分隔符时撞键。 */
export function repoKey(targetId: string, cwd: string): string {
  return JSON.stringify([targetId, cwd])
}

export function isUntracked(file: GitFileStatus): boolean {
  return file.index === '?' || file.worktree === '?'
}

/** porcelain v2 的冲突码：UU / AA / DD / AU / UA / DU / UD。 */
export function isConflict(file: GitFileStatus): boolean {
  if (file.conflict) return true
  const pair = `${file.index ?? ''}${file.worktree ?? ''}`
  return pair.includes('U') || pair === 'AA' || pair === 'DD'
}

/**
 * 冲突单独成组；其余文件按 XY 分别进入已暂存 / 未暂存，
 * 因此「已暂存 M + 工作区又改 M」会同时出现在两组。
 */
export function groupStatusFiles(files: GitFileStatus[]): Record<GitGroupKey, GitFileStatus[]> {
  const groups: Record<GitGroupKey, GitFileStatus[]> = { conflicts: [], staged: [], unstaged: [] }
  for (const file of files) {
    if (isConflict(file)) {
      groups.conflicts.push(file)
      continue
    }
    const index = file.index.trim() || '.'
    const worktree = file.worktree.trim() || '.'
    if (index !== '.' && index !== '?' && index !== '!') groups.staged.push(file)
    if (worktree !== '.' && worktree !== '!') groups.unstaged.push(file)
  }
  return groups
}

export function statusLetter(file: GitFileStatus, group: GitGroupKey): string {
  if (group === 'conflicts') return 'U'
  if (group === 'staged') return file.index.trim() || '.'
  const letter = file.worktree.trim()
  return letter === '.' || letter === '' ? '?' : letter
}

export function statusInfo(letter: string): StatusInfo {
  const raw = (letter ?? '').trim()
  if (!raw || raw === '.' || raw === '!') return { label: '无变化', tone: 'muted' }
  if (raw.length > 1 && (raw.includes('U') || raw === 'AA' || raw === 'DD')) {
    return { label: '冲突', tone: 'danger' }
  }
  switch (raw.charAt(0)) {
    case 'M':
      return { label: '修改', tone: 'warn' }
    case 'A':
      return { label: '新增', tone: 'ok' }
    case 'D':
      return { label: '删除', tone: 'danger' }
    case 'R':
      return { label: '重命名', tone: 'accent' }
    case 'C':
      return { label: '复制', tone: 'accent' }
    case 'U':
      return { label: '冲突', tone: 'danger' }
    case '?':
      return { label: '未跟踪', tone: 'muted' }
    case 'T':
      return { label: '类型变更', tone: 'warn' }
    default:
      return { label: raw, tone: 'muted' }
  }
}

/** 重命名/复制要同时带上原路径，否则 git add / restore 处理不了整组变更。 */
export function filePaths(file: GitFileStatus): string[] {
  return Array.from(
    new Set(
      [file.origPath, file.path].filter((path): path is string => typeof path === 'string' && path.length > 0),
    ),
  )
}

export function pathsFor(files: GitFileStatus[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    for (const path of filePaths(file)) {
      if (seen.has(path)) continue
      seen.add(path)
      out.push(path)
    }
  }
  return out
}

export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')
}

/** status.root（绝对路径）+ porcelain 的相对路径；远端 POSIX、本机 Windows 各自沿用根的分隔符。 */
export function joinRepoPath(root: string, relative: string): string {
  const value = relative.trim()
  if (isAbsolutePath(value)) return value
  const base = root.trim().replace(/[\\/]+$/, '')
  if (!base) return value.replace(/\\/g, '/')
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const rest = value
    .replace(/^\.[\\/]/, '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, sep)
  return `${base}${sep}${rest}`
}

export function aheadBehindText(ahead: number, behind: number): string {
  const up = Math.max(0, Math.floor(Number.isFinite(ahead) ? ahead : 0))
  const down = Math.max(0, Math.floor(Number.isFinite(behind) ? behind : 0))
  if (!up && !down) return '已与远端同步'
  const parts: string[] = []
  if (up) parts.push(`领先 ${up} 个提交`)
  if (down) parts.push(`落后 ${down} 个提交`)
  return parts.join(' · ')
}

export function aheadBehindBadge(ahead: number, behind: number): string {
  const text = aheadBehindText(ahead, behind)
  if (text === '已与远端同步') return ''
  const parts: string[] = []
  if (ahead > 0) parts.push(`↑${ahead}`)
  if (behind > 0) parts.push(`↓${behind}`)
  return parts.join(' ')
}

export function validateCommitMessage(message: string): { ok: boolean; error?: string; warning?: string } {
  const text = message ?? ''
  if (!text.trim()) return { ok: false, error: '请输入提交信息' }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  // 按码点计数，避免 emoji 被算成两个字符。
  const length = Array.from(firstLine.trim()).length
  if (length > 72) return { ok: true, warning: `首行 ${length} 字符，超过 72 字符，建议精简` }
  return { ok: true }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = now - ms
  // 远端时钟偏快时按「刚刚」处理。
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 2 * DAY) return '昨天'
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const date = new Date(ms)
  const md = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === new Date(now).getFullYear() ? md : `${date.getFullYear()}/${md}`
}

export function shortHash(hash: string, length = 7): string {
  return (hash ?? '').trim().slice(0, Math.max(1, length))
}

export function branchLabel(branch: string | null): string {
  return branch?.trim() ? branch : '（分离 HEAD）'
}

export function filterBranches(branches: GitBranch[], query: string): GitBranch[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...branches]
  return branches.filter(
    (branch) =>
      branch.name.toLowerCase().includes(q) || (branch.upstream ?? '').toLowerCase().includes(q),
  )
}

/** 远端分支 origin/foo 切换时用 foo，让 git switch 自动建立跟踪分支而不是进 detached HEAD。 */
export function remoteCheckoutName(name: string): string {
  const slash = name.indexOf('/')
  return slash > 0 ? name.slice(slash + 1) : name
}

export function discardPrompt(files: GitFileStatus[]): string {
  const names = pathsFor(files)
  const untracked = files.some(isUntracked)
  const head = untracked
    ? '将删除文件（未跟踪，不可恢复）：'
    : '将丢弃以下文件的未提交修改，此操作不可撤销：'
  const preview = names.slice(0, 8).map((name) => `· ${name}`).join('\n')
  const more = names.length > 8 ? `\n… 共 ${names.length} 项` : ''
  return `${head}\n${preview}${more}`
}

/** stderr 摘要：去掉换行、遮盖可能的凭据、限长，避免把整段输出塞进错误条。 */
export function stderrSummary(raw: string, max = 240): string {
  const text = (raw ?? '')
    .replace(/(\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***@')
    .replace(/\b(password|passwd|token|secret)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function readError(err: unknown): { code: string | null; message: string } {
  if (typeof err === 'string') return { code: null, message: err }
  if (!err || typeof err !== 'object') return { code: null, message: '' }
  const record = err as { code?: unknown; message?: unknown }
  return {
    code: typeof record.code === 'string' ? record.code : null,
    message: typeof record.message === 'string' ? record.message : '',
  }
}

const codeMessages: Record<string, string> = {
  auth_required: '远端需要认证，请在远端配置 ssh-agent 或凭据助手',
  not_repo: '当前目录不是 Git 仓库',
  git_missing: '未找到 git，请在目标机器安装 Git 后重试',
  not_connected: '目标未连接，请先连接后再操作',
  not_implemented: 'server 尚未实现 Git 能力，请升级 qn-server',
  unknown_method: 'server 不支持该 Git 方法，请升级 qn-server',
  conflict: '存在未解决的冲突，请先处理',
  permission: '没有权限执行该操作',
}

export function describeGitError(
  err: unknown,
  fallback = 'Git 操作失败',
): { code: string | null; message: string } {
  const { code, message } = readError(err)
  const known = code ? codeMessages[code] : undefined
  if (known) return { code, message: known }
  if (code === 'git_failed') {
    const summary = stderrSummary(message)
    return { code, message: summary ? `Git 命令失败：${summary}` : `${fallback}：Git 命令失败` }
  }
  const summary = stderrSummary(message)
  return { code, message: summary || fallback }
}
