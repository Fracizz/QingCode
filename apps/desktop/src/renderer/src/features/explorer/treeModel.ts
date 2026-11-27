// 文件树的纯逻辑：状态变换、排序、扁平化、路径运算与错误文案。
// 不引入 React / backend，便于在 Node 下单测，也便于总管按同一模型合并 fs.watch。

export type ExplorerEntryKind = 'dir' | 'file' | 'symlink'
export type ExplorerEntry = { name: string; kind: ExplorerEntryKind }
export type PathStyle = 'posix' | 'windows'

/** 目录缓存：未出现在 dirs 中即"未加载"。 */
export type DirState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: ExplorerEntry[]; truncated: boolean }

export type TreeState = {
  /** 已展开目录的绝对路径 */
  expanded: string[]
  /** key 为目录绝对路径 */
  dirs: Record<string, DirState | undefined>
  showHidden: boolean
}

export type TreeRow = {
  key: string
  path: string
  name: string
  depth: number
  kind: ExplorerEntryKind | 'placeholder'
  expanded: boolean
  /** placeholder 的提示文案 */
  message?: string
}

export type TreeDraft =
  | { mode: 'create'; parent: string; kind: 'file' | 'dir' }
  | { mode: 'rename'; path: string }

export type DisplayRow =
  | { kind: 'node'; key: string; node: TreeRow }
  | { kind: 'draft'; key: string; path: string; depth: number; draft: TreeDraft }

const MAX_ENTRIES = 2000
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------- 路径 ----------

/** 按 root 的形态判断风格；远端可能是 POSIX，本机 Windows 目标可能是盘符或 UNC。 */
export function detectPathStyle(root: string): PathStyle {
  if (/^[A-Za-z]:[\\/]/.test(root)) return 'windows'
  if (/^\\\\/.test(root) || root.includes('\\')) return 'windows'
  return 'posix'
}

/** 仅用于比较：统一分隔符、去掉尾部斜杠；Windows 忽略大小写。 */
function normalized(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return p || '/'
}

function comparable(path: string, style: PathStyle): string {
  const value = normalized(path)
  return style === 'windows' ? value.toLowerCase() : value
}

function prefix(key: string): string {
  return key.endsWith('/') ? key : `${key}/`
}

/** child 是否为 ancestor 的严格后代（两者相等返回 false）。 */
function isDescendantKey(childKey: string, ancestorKey: string): boolean {
  return childKey !== ancestorKey && childKey.startsWith(prefix(ancestorKey))
}

export function isSamePath(a: string, b: string, style: PathStyle = detectPathStyle(a)): boolean {
  return comparable(a, style) === comparable(b, style)
}

export function isWithinPath(
  child: string,
  ancestor: string,
  style: PathStyle = detectPathStyle(ancestor),
): boolean {
  return isDescendantKey(comparable(child, style), comparable(ancestor, style))
}

function separatorFor(base: string, style: PathStyle): string {
  const trailing = base.match(/[\\/]+$/)
  if (trailing?.[0]) return trailing[0].slice(-1)
  return style === 'windows' && base.includes('\\') ? '\\' : '/'
}

/** 按 base 的分隔符拼接单个名称；root 自身的尾斜杠不重复。 */
export function joinPath(base: string, name: string, style: PathStyle = detectPathStyle(base)): string {
  const child = name.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
  if (!child) return base
  const trimmed = base.replace(/[\\/]+$/, '')
  if (!trimmed) return `${separatorFor(base, style)}${child}`
  return `${trimmed}${separatorFor(base, style)}${child}`
}

export function parentPath(path: string, style: PathStyle = detectPathStyle(path)): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (!trimmed) return path.slice(0, 1) || '/'
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) {
    return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}${separatorFor(path, style)}` : trimmed
  }
  if (index === 0) return trimmed.slice(0, 1)
  const parent = trimmed.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separatorFor(path, style)}`
  return parent
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

/** 复制相对路径用：保持原始大小写，仅在 root 内才返回相对形式。 */
export function relativePath(root: string, path: string, style: PathStyle = detectPathStyle(root)): string {
  const rootKey = comparable(root, style)
  const pathKey = comparable(path, style)
  if (rootKey === pathKey) return ''
  const head = prefix(rootKey)
  if (!pathKey.startsWith(head)) return path
  const rest = normalized(path).slice(head.length)
  return style === 'windows' ? rest.replace(/\//g, '\\') : rest
}

// ---------- 状态 ----------

export function createTreeState(showHidden = false): TreeState {
  return { expanded: [], dirs: {}, showHidden }
}

export function isExpanded(
  state: TreeState,
  path: string,
  style: PathStyle = detectPathStyle(path),
): boolean {
  return state.expanded.some((item) => isSamePath(item, path, style))
}

export function toggleExpanded(
  state: TreeState,
  path: string,
  style: PathStyle = detectPathStyle(path),
): TreeState {
  const expanded = isExpanded(state, path, style)
    ? state.expanded.filter((item) => !isSamePath(item, path, style))
    : [...state.expanded, path]
  return { ...state, expanded }
}

export function collapseAll(state: TreeState): TreeState {
  return { ...state, expanded: [] }
}

export function setShowHidden(state: TreeState, value: boolean): TreeState {
  return { ...state, showHidden: value }
}

function setDir(state: TreeState, path: string, dir: DirState | undefined): TreeState {
  const dirs = { ...state.dirs }
  if (dir) dirs[path] = dir
  else delete dirs[path]
  return { ...state, dirs }
}

export function setDirLoading(state: TreeState, path: string): TreeState {
  return setDir(state, path, { status: 'loading' })
}

export function setDirError(state: TreeState, path: string, message: string): TreeState {
  return setDir(state, path, { status: 'error', message })
}

export function setDirReady(
  state: TreeState,
  path: string,
  entries: ExplorerEntry[],
  truncated = false,
): TreeState {
  return setDir(state, path, { status: 'ready', entries, truncated })
}

/** 重命名/删除后丢弃该目录及其后代的缓存与展开状态，避免展示陈旧路径。 */
export function pruneDirs(
  state: TreeState,
  path: string,
  style: PathStyle = detectPathStyle(path),
): TreeState {
  const key = comparable(path, style)
  const dirs: Record<string, DirState | undefined> = {}
  for (const [dir, value] of Object.entries(state.dirs)) {
    const dirKey = comparable(dir, style)
    if (dirKey === key || isDescendantKey(dirKey, key)) continue
    dirs[dir] = value
  }
  return {
    ...state,
    dirs,
    expanded: state.expanded.filter((item) => {
      const itemKey = comparable(item, style)
      return itemKey !== key && !isDescendantKey(itemKey, key)
    }),
  }
}

// ---------- 排序 / 过滤 / 解析 ----------

/** 目录在前、名称自然排序且大小写不敏感；完全相等时按原字符串稳定定序。 */
export function sortEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  const rank = (kind: ExplorerEntryKind): number =>
    kind === 'dir' ? 0 : kind === 'symlink' ? 1 : 2
  return [...entries].sort((a, b) => {
    const byKind = rank(a.kind) - rank(b.kind)
    if (byKind !== 0) return byKind
    const byName = collator.compare(a.name, b.name)
    if (byName !== 0) return byName
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** 默认隐藏点开头的条目（含 .git），显示隐藏文件时全部放行。 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

export function filterEntries(entries: ExplorerEntry[], showHidden: boolean): ExplorerEntry[] {
  const list = showHidden ? entries : entries.filter((entry) => !isHiddenName(entry.name))
  return sortEntries(list)
}

/** 解析 fs.list 的响应；server 最多返回 2000 条，达到上限即视为截断。 */
export function parseListResult(value: unknown): {
  path: string
  entries: ExplorerEntry[]
  truncated: boolean
} {
  if (!isRecord(value)) return { path: '', entries: [], truncated: false }
  const path = typeof value.path === 'string' ? value.path : ''
  const raw = Array.isArray(value.entries) ? value.entries : []
  const entries: ExplorerEntry[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') continue
    const kind: ExplorerEntryKind =
      item.kind === 'dir' || item.kind === 'symlink' ? item.kind : 'file'
    entries.push({ name: item.name, kind })
  }
  return { path, entries, truncated: entries.length >= MAX_ENTRIES }
}

// ---------- 可见行 ----------

function placeholder(dir: string, depth: number, message: string, tag: string): TreeRow {
  return {
    key: `${dir}::${tag}`,
    path: dir,
    name: message,
    depth,
    kind: 'placeholder',
    expanded: false,
    message,
  }
}

/** 深度优先扁平化，供定高虚拟列表直接使用；符号链接成环时不再深入。 */
export function visibleRows(
  state: TreeState,
  root: string,
  style: PathStyle = detectPathStyle(root),
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number, ancestors: Set<string>): void => {
    const dirState = state.dirs[dir]
    if (!dirState) {
      rows.push(placeholder(dir, depth, '尚未加载', 'idle'))
      return
    }
    if (dirState.status === 'loading') {
      rows.push(placeholder(dir, depth, '加载中…', 'loading'))
      return
    }
    if (dirState.status === 'error') {
      rows.push(placeholder(dir, depth, `加载失败：${dirState.message}`, 'error'))
      return
    }
    const shown = filterEntries(dirState.entries, state.showHidden)
    if (shown.length === 0) {
      rows.push(placeholder(dir, depth, '（空目录）', 'empty'))
      return
    }
    if (dirState.truncated) {
      rows.push(placeholder(dir, depth, '仅显示前 2000 项', 'truncated'))
    }
    for (const entry of shown) {
      const path = joinPath(dir, entry.name, style)
      const expandable = entry.kind === 'dir' || entry.kind === 'symlink'
      const expanded = expandable && isExpanded(state, path, style)
      rows.push({
        key: path,
        path,
        name: entry.name,
        depth,
        kind: entry.kind,
        expanded,
      })
      const key = comparable(path, style)
      if (expanded && !ancestors.has(key)) {
        walk(path, depth + 1, new Set([...ancestors, key]))
      }
    }
  }
  walk(root, 0, new Set([comparable(root, style)]))
  return rows
}

/** 把行内新建/重命名输入框插入虚拟列表；create 在父目录之后，rename 原位替换。 */
export function withDraft(
  rows: TreeRow[],
  draft: TreeDraft | null,
  root: string,
  style: PathStyle = detectPathStyle(root),
): DisplayRow[] {
  const base: DisplayRow[] = rows.map((node) => ({ kind: 'node', key: node.key, node }))
  if (!draft) return base
  if (draft.mode === 'rename') {
    return base.map((row) =>
      row.kind === 'node' && isSamePath(row.node.path, draft.path, style)
        ? {
            kind: 'draft',
            key: `draft:${row.key}`,
            path: row.node.path,
            depth: row.node.depth,
            draft,
          }
        : row,
    )
  }
  if (isSamePath(draft.parent, root, style)) {
    base.unshift({
      kind: 'draft',
      key: `draft:${draft.parent}:${draft.kind}`,
      path: draft.parent,
      depth: 0,
      draft,
    })
    return base
  }
  const index = rows.findIndex((row) => isSamePath(row.path, draft.parent, style))
  const parent = index >= 0 ? rows[index] : undefined
  const depth = parent ? parent.depth + 1 : 0
  const insertAt = index >= 0 ? index + 1 : 0
  base.splice(insertAt, 0, {
    kind: 'draft',
    key: `draft:${draft.parent}:${draft.kind}`,
    path: draft.parent,
    depth,
    draft,
  })
  return base
}

// ---------- fs.changed ----------

/**
 * 变化路径 → 需要重新 fs.list 的目录集合（只从已加载/已展开的目录中挑）。
 * 变化路径本身是目录、其父目录、以及它的已加载后代都要刷新；
 * 变化发生在 root 的祖先时（如整个项目被移动）刷新全部。
 */
export function dirsToRefresh(
  root: string,
  loadedDirs: string[],
  expandedDirs: string[],
  changedPaths: string[],
  style: PathStyle = detectPathStyle(root),
): string[] {
  const candidates = [...new Set([...loadedDirs, ...expandedDirs])]
  const rootKey = comparable(root, style)
  const refresh = new Set<string>()
  for (const raw of changedPaths) {
    if (typeof raw !== 'string' || raw === '') continue
    const changedKey = comparable(raw, style)
    if (isDescendantKey(rootKey, changedKey)) {
      for (const candidate of candidates) refresh.add(candidate)
      continue
    }
    if (changedKey !== rootKey && !isDescendantKey(changedKey, rootKey)) continue
    const parentKey = comparable(parentPath(raw, style), style)
    for (const candidate of candidates) {
      const candidateKey = comparable(candidate, style)
      if (
        candidateKey === changedKey ||
        candidateKey === parentKey ||
        isDescendantKey(candidateKey, changedKey)
      ) {
        refresh.add(candidate)
      }
    }
  }
  return [...refresh].sort((a, b) => a.length - b.length || a.localeCompare(b))
}

// ---------- 名称与错误 ----------

/** 返回中文错误原因，null 表示可用；Windows 风格额外禁用 NTFS 保留字符。 */
export function validateEntryName(name: string, style: PathStyle): string | null {
  if (name.trim() === '') return '名称不能为空'
  if (/[\\/]/.test(name)) return '名称不能包含路径分隔符 / 或 \\'
  if (name === '.' || name === '..') return '名称不能是 . 或 ..'
  if (style === 'windows' && /[<>:"/|?*]/.test(name)) return '名称不能包含 < > : " | ? *'
  if (/[\u0000-\u001f]/.test(name)) return '名称不能包含控制字符'
  return null
}

const ERROR_TEXT: Record<string, string> = {
  params: '参数无效',
  invalid_params: '参数无效',
  not_found: '文件或目录不存在',
  exists: '同名文件或目录已存在',
  not_empty: '目录非空，请勾选「连同目录内容一起删除」',
  conflict: '文件已被外部修改，请刷新后重试',
  too_large: '内容过大，无法处理',
  permission: '没有权限执行此操作',
  forbidden: '没有权限执行此操作',
  not_repo: '该目录不是 Git 仓库',
  git_missing: '目标上没有安装 git',
  auth_required: '需要认证，请先在目标上配置凭据',
  git_failed: 'git 命令执行失败',
  internal: '服务端内部错误',
  unknown_method: '目标服务端版本过旧，不支持此操作',
  not_implemented: '后端功能尚未接入，当前版本暂不可用',
  not_ready: '目标尚未连接就绪',
  port_replaced: '通信通道已重建，请重试',
  auth: '认证失败',
  protocol: '协议版本不匹配，请更新两端程序',
}

/** server 的 WorkspaceErrorCode / backend 错误码 → 中文短句。 */
export function workspaceErrorMessage(code: string, raw = ''): string {
  return ERROR_TEXT[code] ?? (raw || '操作失败')
}

/** 组件统一用它把异常转成可展示文案；不打印 token 与凭据。 */
export function describeWorkspaceError(err: unknown, fallback = '操作失败'): string {
  const record = isRecord(err) ? err : {}
  const code = typeof record.code === 'string' || typeof record.code === 'number'
    ? String(record.code)
    : ''
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : typeof record.message === 'string'
          ? record.message
          : ''
  const detail = code ? workspaceErrorMessage(code, raw) : raw || '未知错误'
  return `${fallback}：${detail}`
}
