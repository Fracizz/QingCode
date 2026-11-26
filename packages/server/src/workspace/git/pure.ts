import path from 'node:path'
import type { GitBranch } from '@qn/protocol'
import { WorkspaceError } from '../registry'

/** 客户端可能给绝对路径或根相对路径；统一成仓库根相对、`/` 分隔的 git pathspec。 */
export function toRepoRelative(root: string, input: string): string {
  if (input.includes('\0')) throw new WorkspaceError('params', '路径不能包含 NUL 字节')
  const absolute = path.isAbsolute(input)
  let rel = absolute ? path.relative(root, input) : input
  if (absolute && path.isAbsolute(rel)) {
    throw new WorkspaceError('params', `路径不在仓库内: ${input}`)
  }
  rel = path.posix.normalize(rel.replace(/\\/g, '/'))
  if (rel === '') rel = '.'
  if (rel === '..' || rel.startsWith('../') || /^[A-Za-z]:\//.test(rel)) {
    throw new WorkspaceError('params', `路径不在仓库内: ${input}`)
  }
  return rel
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
