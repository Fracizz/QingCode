import path from 'node:path'
import type { GitBranch } from '@qn/protocol'
import { looksWindowsPath, pickPathImpl, stripLongPathPrefix } from '../paths'
import { WorkspaceError } from '../registry'

/**
 * 客户端可能给绝对路径或根相对路径；统一成仓库根相对、`/` 分隔的 git pathspec。
 * Windows 根的盘符大小写、混用斜杠与 \\?\ 前缀都要先归一再比较。
 */
export function toRepoRelative(
  root: string,
  input: string,
  platform: string = process.platform,
): string {
  if (input.includes('\0')) throw new WorkspaceError('params', '路径不能包含 NUL 字节')
  const p = pickPathImpl(root, input, platform)
  const absolute = p.isAbsolute(stripLongPathPrefix(input))
  let rel = absolute
    ? p.relative(stripLongPathPrefix(root), stripLongPathPrefix(input))
    : input
  if (absolute && p.isAbsolute(rel)) {
    throw new WorkspaceError('params', `路径不在仓库内: ${input}`)
  }
  rel = path.posix.normalize(rel.replace(/\\/g, '/'))
  if (rel === '') rel = '.'
  if (rel === '..' || rel.startsWith('../') || /^[A-Za-z]:\//.test(rel)) {
    throw new WorkspaceError('params', `路径不在仓库内: ${input}`)
  }
  return rel
}

/**
 * Windows 的 git pathspec 仍区分大小写；把客户端传来的相对路径按磁盘上真实名称归一，
 * 大小写不敏感比较集中在这里（readdir 由调用方注入，保持纯函数可测）。
 */
export function canonicalizeRepoRelative(
  root: string,
  rel: string,
  readdir: (absoluteDir: string) => readonly string[],
  caseSensitive = false,
): string {
  if (rel === '.' || rel === '') return '.'
  const p = pickPathImpl(root, root)
  let current = stripLongPathPrefix(root)
  const result: string[] = []
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    let entries: readonly string[] = []
    try {
      entries = readdir(current)
    } catch {
      // 目录不存在（如新建/已删除的文件）时保留客户端给的写法。
    }
    const matched = caseSensitive
      ? entries.find((entry) => entry === part)
      : entries.find((entry) => entry.toLowerCase() === part.toLowerCase())
    const chosen = matched ?? part
    result.push(chosen)
    current = p.join(current, chosen)
  }
  return result.length > 0 ? result.join('/') : '.'
}

/** 是否需要在 Windows 语义下做大小写归一。 */
export function needCaseCanonicalization(root: string, platform: string = process.platform): boolean {
  return platform === 'win32' || looksWindowsPath(root)
}

export interface SwitchPlan {
  args: string[]
}

/** `origin/x` 形式的远端分支：本地同名分支已存在就切过去，否则用 --track 创建。 */
export function planSwitch(
  branch: string,
  create: boolean,
  refs: { local: GitBranch[]; remote: GitBranch[] },
): SwitchPlan {
  if (create) return { args: ['switch', '-c', branch] }
  if (!refs.remote.some((item) => item.name === branch)) {
    return { args: ['switch', branch] }
  }
  const localName = branch.slice(branch.indexOf('/') + 1)
  if (refs.local.some((item) => item.name === localName)) {
    return { args: ['switch', localName] }
  }
  return { args: ['switch', '--track', branch] }
}
