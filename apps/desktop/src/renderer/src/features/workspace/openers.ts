// 打开文件/差异的进程内总线：聊天、Git 面板、文件树只调用这里，
// 文件查看面板（T18）订阅并负责展示，各功能互不直接依赖。

export type OpenFileRequest = {
  targetId: string
  /** 绝对路径 */
  path: string
  /** 1 起始 */
  line?: number
  column?: number
}

export type OpenDiffRequest = {
  targetId: string
  /** 绝对路径 */
  path: string
  /** 仓库内任意目录，供 git.* 使用 */
  cwd: string
  /**
   * worktree：HEAD ↔ 工作区（默认）；staged：HEAD ↔ 暂存区；
   * commit：该提交相对父提交（需 commit）；text：直接展示给定 diff 文本
   */
  mode?: 'worktree' | 'staged' | 'commit' | 'text'
  commit?: string
  diff?: string
  title?: string
}

export type OpenRequest = ({ kind: 'file' } & OpenFileRequest) | ({ kind: 'diff' } & OpenDiffRequest)

type Listener = (req: OpenRequest) => void
const listeners = new Set<Listener>()

export function subscribeOpen(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function openFile(req: OpenFileRequest): void {
  for (const listener of listeners) listener({ kind: 'file', ...req })
}

export function openDiff(req: OpenDiffRequest): void {
  for (const listener of listeners) listener({ kind: 'diff', ...req })
}
