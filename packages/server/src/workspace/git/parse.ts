import type {
  GitBranch,
  GitCommit,
  GitFileStatus,
  GitStatusResult,
} from '@qn/protocol'

export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e'
export const BRANCH_FORMAT =
  '%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)'

/** -z 输出以 NUL 结尾；末尾的空串不是数据。 */
export function splitNul(text: string): string[] {
  if (!text) return []
  const parts = text.split('\0')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

/** 跳过前 count 个以空格分隔的固定字段，其余整体是路径（路径可含空格，不能按空格切）。 */
function fieldAfter(token: string, count: number): string {
  let offset = 0
  for (let i = 0; i < count; i++) {
    const next = token.indexOf(' ', offset)
    if (next < 0) return ''
    offset = next + 1
  }
  return token.slice(offset)
}

function isRecordStart(token: string | undefined): boolean {
  if (token === undefined) return false
  return /^(?:# |[12u?!] )/.test(token)
}

/**
 * 解析 `status --porcelain=v2 -z --branch --untracked-files=all`。
 * -z 下头部行与条目同样以 NUL 结尾，重命名的原路径是紧跟其后的独立字段。
 */
export function parseStatus(output: string): Omit<GitStatusResult, 'root'> {
  const tokens = splitNul(output)
  let branch: string | null = null
  let head: string | null = null
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === undefined) continue

    if (token.startsWith('# ')) {
      const space = token.indexOf(' ', 2)
      const key = space < 0 ? token.slice(2) : token.slice(2, space)
      const value = space < 0 ? '' : token.slice(space + 1)
      switch (key) {
        case 'branch.oid':
          head = value === '(initial)' || value === '' ? null : value
          break
        case 'branch.head':
          branch = value === '(detached)' || value === '' ? null : value
          break
        case 'branch.upstream':
          upstream = value
          break
        case 'branch.ab':
          ahead = Number(/\+(\d+)/.exec(value)?.[1] ?? 0)
          behind = Number(/-(\d+)/.exec(value)?.[1] ?? 0)
          break
        default:
          break
      }
      continue
    }

    const kind = token[0]
    if (kind === '1' || kind === '2' || kind === 'u') {
      const xy = token.slice(2, 4)
      const path = fieldAfter(token, kind === '1' ? 8 : kind === '2' ? 9 : 10)
      let origPath: string | undefined
      if (kind === '2' && !isRecordStart(tokens[i + 1])) {
        origPath = tokens[i + 1]
        i++
      }
      files.push({
        path,
        ...(origPath !== undefined ? { origPath } : {}),
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        conflict: kind === 'u',
      })
      continue
    }

    if (kind === '?' || kind === '!') {
      files.push({
        path: token.slice(2),
        index: kind,
        worktree: kind,
        conflict: false,
      })
    }
  }

  return { branch, head, upstream, ahead, behind, files }
}

/** 解析 log 的 %x00 字段 + %x1e 记录分隔；git 会在每条 format 后补一个换行。 */
export function parseLog(output: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const raw of output.split('\x1e')) {
    const record = raw.replace(/^\r?\n/, '')
    if (!record.includes('\0')) continue
    const [hash, parents = '', author = '', email = '', at = '', subject = ''] =
      record.split('\0')
    if (!hash) continue
    const seconds = Number(at)
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      author,
      email,
      date: Number.isFinite(seconds) ? seconds * 1000 : 0,
      subject,
    })
  }
  return commits
}

export interface ParsedBranches {
  current: string | null
  local: GitBranch[]
  remote: GitBranch[]
}

/** 解析 for-each-ref；过滤 origin/HEAD 这类符号引用。 */
export function parseBranchRefs(output: string): ParsedBranches {
  const result: ParsedBranches = { current: null, local: [], remote: [] }
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) continue
    const [refname = '', short = '', head = '', upstream = '', mark = ''] = line.split('\0')
    if (!short || short.endsWith('/HEAD')) continue
    const branch: GitBranch = { name: short, head, ...(upstream ? { upstream } : {}) }
    if (refname.startsWith('refs/heads/')) {
      result.local.push(branch)
      if (mark === '*') result.current = short
    } else if (refname.startsWith('refs/remotes/')) {
      result.remote.push(branch)
    }
  }
  return result
}

/** 解析 `show --name-status -z --format= -M`：R/C 状态后面依次是原路径、新路径。 */
export function parseNameStatus(
  output: string,
): Array<{ path: string; origPath?: string; status: string }> {
  const tokens = splitNul(output)
  const files: Array<{ path: string; origPath?: string; status: string }> = []
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]
    if (status === undefined || !/^[A-Z]\d*$/.test(status)) continue
    if (/^[RC]\d*$/.test(status)) {
      const origPath = tokens[i + 1]
      const path = tokens[i + 2]
      if (origPath === undefined || path === undefined) break
      files.push({ path, origPath, status })
      i += 2
    } else {
      const path = tokens[i + 1]
      if (path === undefined) break
      files.push({ path, status })
      i++
    }
  }
  return files
}
