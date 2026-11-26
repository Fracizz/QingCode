// 文件与 Git 的 server 协议契约（docs/roadmap.md §4）。
// server 实现与渲染进程调用都以此为准；改字段需同时改两侧。

/** 文件/Git 方法统一错误码；server 以 res.error.code 返回。 */
export type WorkspaceErrorCode =
  | 'params'
  | 'not_found'
  | 'exists'
  | 'not_empty'
  | 'conflict'
  | 'too_large'
  | 'permission'
  | 'not_repo'
  | 'git_missing'
  | 'auth_required'
  | 'git_failed'
  | 'internal'

export type FsKind = 'dir' | 'file' | 'symlink'

export type FsStat = {
  path: string
  kind: FsKind
  size: number
  mtimeMs: number
}

export type FsReadParams = {
  path: string
  /** 字节偏移，默认 0 */
  offset?: number
  /** 读取字节数，默认且最多 2 MiB（图片 base64 时最多 10 MiB） */
  length?: number
  /** 'base64' 强制按二进制读（图片预览）；缺省自动判断 */
  encoding?: 'utf8' | 'base64'
}

export type FsReadResult = {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
  /** 文件总字节数 */
  size: number
  mtimeMs: number
  offset: number
  /** 本次读取字节数 */
  length: number
  /** offset + length < size */
  truncated: boolean
  /** 自动判断为二进制且未请求 base64 时为 true，content 为空 */
  binary: boolean
  /** 原文件带 BOM（UTF-8 或 UTF-16）；写回时把该值原样传回 fs.write.bom */
  bom?: boolean
  /** UTF-16 源文件已解码成 utf8 内容；写回时把该值原样传回 fs.write.sourceEncoding */
  sourceEncoding?: 'utf16le' | 'utf16be'
}

export type FsWriteParams = {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
  /** 与当前 mtime 不符则返回 conflict；缺省不检查 */
  expectedMtimeMs?: number
  /** 文件不存在时是否创建，默认 true */
  create?: boolean
  /** 写文本 BOM：未指定 sourceEncoding 时写 UTF-8 BOM，否则写 FF FE / FE FF */
  bom?: boolean
  /** 按 UTF-16 源编码写回（content 仍是 utf8 文本）；base64 写入忽略这两个字段 */
  sourceEncoding?: 'utf16le' | 'utf16be'
}

export type FsSearchMode = 'name' | 'content'

export type FsSearchParams = {
  root: string
  query: string
  mode: FsSearchMode
  /** 仅匹配该 glob（相对 root，如 `*.ts`、`src/**`） */
  glob?: string
  caseSensitive?: boolean
  /** 默认 500，最多 5000 */
  maxResults?: number
}

export type FsSearchMatch = {
  /** 绝对路径 */
  path: string
  /** content 模式：1 起始行号与该行文本（截断到 300 字符） */
  line?: number
  column?: number
  text?: string
}

/** evt `fs.searchResult`：同一 searchId 可多次推送，最后一次 done:true */
export type FsSearchResultEvt = {
  searchId: string
  matches: FsSearchMatch[]
  done: boolean
  /** done 时给出：是否因 maxResults 截断 */
  truncated?: boolean
  error?: string
}

/** evt `fs.changed`：仅推送给登记了监听的客户端，200ms 去抖合并 */
export type FsChangedEvt = { paths: string[] }

export type GitFileStatus = {
  /** 相对仓库根，`/` 分隔 */
  path: string
  /** 重命名/复制的原路径 */
  origPath?: string
  /** porcelain XY 中的 X（暂存区）；'.' 表示无变化，'?' 未跟踪，'!' 忽略 */
  index: string
  /** porcelain XY 中的 Y（工作区） */
  worktree: string
  conflict: boolean
}

export type GitStatusResult = {
  root: string
  /** detached 时为 null */
  branch: string | null
  head: string | null
  upstream?: string
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export type GitBranch = { name: string; upstream?: string; head: string }

export type GitCommit = {
  hash: string
  parents: string[]
  author: string
  email: string
  /** 毫秒时间戳 */
  date: number
  subject: string
}

export interface WorkspaceMethods {
  'fs.stat': { params: { path: string }; result: FsStat }
  'fs.read': { params: FsReadParams; result: FsReadResult }
  'fs.write': { params: FsWriteParams; result: { mtimeMs: number } }
  'fs.mkdir': { params: { path: string }; result: Record<string, never> }
  'fs.createFile': { params: { path: string }; result: Record<string, never> }
  'fs.rename': { params: { from: string; to: string }; result: Record<string, never> }
  'fs.delete': { params: { path: string; recursive?: boolean }; result: Record<string, never> }
  'fs.search': { params: FsSearchParams; result: { searchId: string } }
  'fs.searchCancel': { params: { searchId: string }; result: Record<string, never> }
  /** 全量替换本连接的监听集合；空数组即取消全部 */
  'fs.watch': { params: { paths: string[] }; result: Record<string, never> }

  'git.status': { params: { cwd: string }; result: GitStatusResult }
  'git.diff': {
    params: { cwd: string; path?: string; staged?: boolean; contextLines?: number; commit?: string }
    result: { diff: string; truncated: boolean }
  }
  'git.show': {
    params: { cwd: string; path: string; ref?: string }
    result: { content: string; binary: boolean; exists: boolean }
  }
  'git.stage': { params: { cwd: string; paths: string[] }; result: Record<string, never> }
  'git.unstage': { params: { cwd: string; paths: string[] }; result: Record<string, never> }
  'git.discard': {
    params: { cwd: string; paths: string[]; includeUntracked?: boolean }
    result: Record<string, never>
  }
  'git.commit': {
    params: { cwd: string; message: string; amend?: boolean }
    result: { commit: string }
  }
  'git.branches': {
    params: { cwd: string }
    result: { current: string | null; local: GitBranch[]; remote: GitBranch[] }
  }
  'git.switch': {
    params: { cwd: string; branch: string; create?: boolean }
    result: Record<string, never>
  }
  'git.fetch': { params: { cwd: string; remote?: string }; result: { output: string } }
  'git.pull': { params: { cwd: string; remote?: string; branch?: string }; result: { output: string } }
  'git.push': {
    params: { cwd: string; remote?: string; branch?: string; setUpstream?: boolean }
    result: { output: string }
  }
  'git.log': {
    params: { cwd: string; path?: string; limit?: number; skip?: number }
    result: { commits: GitCommit[] }
  }
  'git.commitFiles': {
    params: { cwd: string; commit: string }
    result: { files: Array<{ path: string; origPath?: string; status: string }> }
  }
  /** 可用性探测：只运行 `<exe> --version`（docs/agent-adapters.md §7）。 */
  'agent.probe': { params: AgentProbeParams; result: AgentProbeResult }
}

export type WorkspaceMethod = keyof WorkspaceMethods

/** 探测目标机上用户已安装的 Agent；不开会话、不读凭据、不下载安装。 */
export type AgentProbeAgent = 'codex' | 'claude' | 'pi'

export type AgentProbeParams = {
  agent: AgentProbeAgent
  /** 留空则按 PATH / 常见安装目录解析 */
  path?: string
}

export type AgentProbeResult = {
  found: boolean
  /** 实际找到的可执行文件；未找到时为传入路径或空串 */
  path: string
  version?: string
  error?: string
}
