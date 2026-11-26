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
  | TermErrorCode

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

export type ProjectFileEntry = { path: string; name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number }
export type ProjectFileList = { entries: ProjectFileEntry[]; truncated: boolean }
export type ProjectFileChunk = { content: string; length: number; size: number; version: string }

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
  'fs.project.list': { params: { root: string; path?: string; hidden?: boolean }; result: ProjectFileList }
  'fs.project.search': { params: { root: string; path?: string; query: string; hidden?: boolean; limit?: number }; result: ProjectFileList }
  'fs.project.read': { params: { root: string; path: string; offset?: number; length?: number; version?: string }; result: ProjectFileChunk }
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

// ---- 终端 term.*（docs/spikes/terminal.md §6，T29 定稿） ----
// PTY 字节一律 base64；终端归 daemon 所有，连接断开只取消订阅、不关终端。

export type TermErrorCode =
  /** 目标上没有可用的 PTY 后端（远端缺 python3 与 util-linux script；Windows 未接 ConPTY） */
  | 'pty_unavailable'
  | 'term_not_found'
  /** 终端已退出（缓冲仍可 attach），不能再写入 */
  | 'term_exited'
  /** 写入队列积压，客户端应稍后重试 */
  | 'term_backpressure'
  /** term.write 单次超过 1 MiB 原始字节 */
  | 'term_input_too_large'
  | 'term_spawn_failed'
  /** 同时存活的终端数达到上限 */
  | 'term_limit'

export type TermBackend = 'python' | 'script' | 'conpty'
export type TermBackendPreference = 'auto' | TermBackend

export type TermOpenParams = {
  /** 留空由 server 生成；已存在则直接接回（created:false），忽略其余参数 */
  termId?: string
  /** 必须是绝对路径且存在 */
  cwd: string
  /** 默认 $SHELL，否则 /bin/sh */
  shell?: string
  args?: string[]
  /** 默认 80×24，规整到 1..1000 */
  cols?: number
  rows?: number
  /** 叠加到 daemon 环境上；LD_*、DYLD_*、PYTHON*、QN_* 等被拒绝 */
  env?: Record<string, string>
  backend?: TermBackendPreference
}

export type TermExitInfo = {
  code: number | null
  /** 信号名，如 'SIGHUP' */
  signal: string | null
}

export type TermInfo = {
  termId: string
  cwd: string
  shell: string
  args: string[]
  pid: number | null
  backend: TermBackend
  /** script 兜底为 false：运行时改尺寸无效 */
  supportsResize: boolean
  alive: boolean
  exit?: TermExitInfo
  lastSeq: number
  cols: number
  rows: number
  /** 毫秒时间戳 */
  startedAt: number
  exitedAt?: number
}

export type TermOpenResult = TermInfo & { created: boolean }

export type TermOutputChunk = { seq: number; data: string }

/** 渲染端序列化的屏幕快照（如 @xterm/addon-serialize），代表 seq ≤ snapshot.seq 的全部输出 */
export type TermSnapshot = { seq: number; data: string; cols: number; rows: number }

export type TermAttachParams = {
  termId: string
  /** 客户端已收到的最大 seq；首次接回传 0 */
  sinceSeq?: number
}

export type TermAttachResult = TermInfo & {
  /**
   * replay：chunks 即缺失的增量，直接写入；
   * snapshot：先清屏写 snapshot，再写 chunks；
   * resync：缓冲已截断且无可用快照，清屏后写 chunks 并提示历史输出已丢失
   */
  mode: 'replay' | 'snapshot' | 'resync'
  truncated: boolean
  chunks: TermOutputChunk[]
  snapshot?: TermSnapshot
}

/** evt `term.data`：只发给订阅了该终端（open/attach 过且未 detach）的连接 */
export type TermDataEvt = { termId: string; seq: number; data: string }
/** evt `term.exit`：在最后一块 term.data 之后发出 */
export type TermExitEvt = { termId: string } & TermExitInfo
/** evt `term.resized`：by 为发起改尺寸的连接 clientId */
export type TermResizedEvt = { termId: string; cols: number; rows: number; by: number | null }
/** evt `term.error`：终端运行中的异步错误（同步错误走 res.error） */
export type TermErrorEvt = { termId: string; code: TermErrorCode | 'internal'; message: string }

// 用接口合并追加 term.* 条目，避免与其他任务在同一接口体内交叉编辑。
export interface WorkspaceMethods {
  'term.open': { params: TermOpenParams; result: TermOpenResult }
  /** data 为 base64；返回实际接受的原始字节数 */
  'term.write': { params: { termId: string; data: string }; result: { acceptedBytes: number } }
  /** applied:false 表示后端不支持运行时改尺寸（script 兜底），尺寸保持不变 */
  'term.resize': {
    params: { termId: string; cols: number; rows: number }
    result: { applied: boolean; cols: number; rows: number }
  }
  /** 终止并释放缓冲；未知或已关闭的 termId 也返回成功（幂等） */
  'term.close': { params: { termId: string }; result: Record<string, never> }
  /** 订阅并取回缺失输出；之后的输出经 evt term.data 推送 */
  'term.attach': { params: TermAttachParams; result: TermAttachResult }
  /** 仅取消本连接的订阅，终端继续运行 */
  'term.detach': { params: { termId: string }; result: Record<string, never> }
  /** 上传屏幕快照供缓冲截断后的接回使用；seq 比已存快照旧时 stored:false */
  'term.snapshot': { params: { termId: string } & TermSnapshot; result: { stored: boolean } }
  'term.list': { params: Record<string, never>; result: { terminals: TermInfo[] } }
}

// ---- 运行配置 run.*（docs/tasks/T26-run-configs.md） ----
// 运行配置是用户自己的命令：只有用户点击才 run.start，server 不自动执行任何命令。
// 进程归 daemon 所有，客户端断开不停止；输出以 utf8 文本推送，保留 ANSI 转义。

export type RunTaskType = 'command' | 'ps1' | 'bat' | 'sh' | 'script'
export type RunOs = 'windows' | 'linux' | 'macos'

/** 旧版 run.json 中 `task.os.<系统>` 的覆盖字段 */
export type RunTaskOverride = {
  type?: RunTaskType
  target?: string
  cwd?: string
  env?: Record<string, string>
}

export type RunStartTask = {
  type: RunTaskType
  /** command 为命令行；其余类型为脚本路径（相对 task.cwd） */
  target: string
  /** 相对 params.cwd，也可为绝对路径 */
  cwd?: string
  env?: Record<string, string>
  /** 可选：按 server 所在系统合并覆盖后再执行（客户端已解析时不传） */
  os?: Partial<Record<RunOs, RunTaskOverride>>
}

export type RunStartParams = {
  /** 项目根，绝对路径 */
  cwd: string
  task: RunStartTask
  /** 显示名 */
  label?: string
  /** 客户端自定义关联键（如 `<configId>/<taskId>`），原样出现在 RunInfo 中 */
  key?: string
}

export type RunInfo = {
  runId: string
  label: string
  key?: string
  /** run.start 的 params.cwd（项目根） */
  cwd: string
  /** 实际工作目录 */
  workdir: string
  /** 便于展示的完整命令行 */
  command: string
  pid: number | null
  startedAt: number
  /** 运行中为 undefined；被信号结束时为 null */
  exitCode?: number | null
  signal?: string | null
  endedAt?: number
  lastSeq: number
}

export type RunOutputChunk = { seq: number; stream: 'stdout' | 'stderr'; data: string }

export type RunOutputResult = {
  runId: string
  chunks: RunOutputChunk[]
  /** 缓冲（每个 run 1 MiB）已丢弃了 seq > sinceSeq 的部分旧输出 */
  truncated: boolean
  lastSeq: number
  running: boolean
}

/** evt `run.data`：广播给调用过任意 run.* 的连接，前端按 runId 过滤 */
export type RunDataEvt = { runId: string } & RunOutputChunk
/** evt `run.exit`：在该 run 最后一块 run.data 之后发出 */
export type RunExitEvt = { runId: string; exitCode: number | null; signal: string | null }

// 用接口合并追加 run.* 条目，避免与其他任务在同一接口体内交叉编辑。
export interface WorkspaceMethods {
  'run.start': { params: RunStartParams; result: { runId: string; pid: number | null } }
  /** 未知或已结束的 runId 也返回成功（幂等） */
  'run.stop': { params: { runId: string }; result: Record<string, never> }
  /** 运行中的全部 + 最近结束的 20 条；platform 供客户端按 task.os 过滤 */
  'run.list': { params: Record<string, never>; result: { platform: RunOs; runs: RunInfo[] } }
  'run.output': { params: { runId: string; sinceSeq?: number }; result: RunOutputResult }
}
