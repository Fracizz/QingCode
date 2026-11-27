import { create } from 'zustand'
import { useDock } from '../../store/dock'
import type { FsReadParams, FsWriteParams } from '@qn/protocol'
import { onServerEvt, serverCall } from '../workspace/serverCall'
import { subscribeOpen, type OpenRequest } from '../workspace/openers'
import { dirname, fileKind } from './fileLinks'
import {
  changedPaths,
  closeTab,
  createTab,
  errorCodeOf,
  errorMessage,
  failedTab,
  mergeRead,
  pathWatchKey,
  upsertTab,
  watchKey,
  watchPaths,
  type Tab,
  type TabStatus,
  type TabView,
} from './filesModel'
import {
  applyLocalEdit,
  isDirty,
  markDiskChanged,
  markSaveFailed,
  markSaved,
  markSaving,
  planConflict,
  readOnlyReason,
  toDiskText,
  type ConflictAction,
  type FilePrompt,
} from './editModel'
import { clearEditorStates, forgetEditorState } from './editor/stateCache'

export type SaveOptions = {
  /** 不带 expectedMtimeMs 直接重写（冲突时的「覆盖」）。 */
  force?: boolean
  expectedMtimeMs?: number
  /** 已是磁盘格式的文本（由冲突计划或合并结果给出）。 */
  content?: string
}

export type FilesState = {
  tabs: Tab[]
  activeId: string | null
  /** 对话旁的文件面板仅在有标签时可以展开。 */
  open: boolean
  /** 保存冲突 / 关闭确认 / 合并对话框。 */
  prompt: FilePrompt | null
  setOpen: (open: boolean) => void
  activate: (id: string) => void
  close: (id: string) => void
  closeAll: () => void
  setView: (id: string, view: TabView) => void
  refresh: (id: string) => void
  loadMore: (id: string) => void
  /** 仅供打开请求总线回调使用。 */
  handleOpen: (req: OpenRequest) => void
  edit: (id: string, text: string) => void
  save: (id: string, options?: SaveOptions) => Promise<boolean>
  requestClose: (id: string) => void
  requestCloseAll: (ids?: string[]) => void
  confirmClose: (saveFirst: boolean) => void
  confirmRefresh: (decision: 'save' | 'discard' | 'cancel') => void
  resolveConflict: (action: ConflictAction) => void
  saveCompare: (id: string, text: string) => Promise<void>
  dismissPrompt: () => void
}

let nextTabId = 1

export const useFiles = create<FilesState>((set, get) => ({
  tabs: [],
  activeId: null,
  open: false,
  prompt: null,

  setOpen: (open) => set((state) => ({ open: open && state.tabs.length > 0 })),
  activate: (id) => set((state) => {
    if (!state.tabs.some((tab) => tab.id === id)) return state
    return { activeId: id, open: state.open || useDock.getState().view === 'chat' }
  }),
  close: (id) => forceClose(id),
  closeAll: () => {
    set({ tabs: [], activeId: null, open: false, prompt: null })
    clearEditorStates()
  },
  setView: (id, view) =>
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, view } : tab)) })),

  refresh: (id) => {
    const tab = get().tabs.find((item) => item.id === id)
    if (!tab) return
    if (tab.kind === 'file' && isDirty(tab)) {
      set({ prompt: { kind: 'refresh', id } })
      return
    }
    if (tab.kind === 'file') startRead(id, false)
    else startDiff(id)
  },

  loadMore: (id) => {
    const tab = get().tabs.find((item) => item.id === id)
    // 图片的 base64 分片不能简单拼接，交给"文件过大"提示处理。
    if (!tab || tab.kind !== 'file' || !tab.truncated || fileKind(tab.path) === 'image') return
    startRead(id, true)
  },

  handleOpen: (req) => {
    const incoming = createTab(req, `tab-${nextTabId++}`)
    const result = upsertTab(get().tabs, incoming)
    const { view, setView } = useDock.getState()
    set({ tabs: result.tabs, activeId: result.id, open: get().open || view !== 'files' })
    // 收起工作视图后，仍可通过快速打开直接看到文件。
    if (view === null) setView('chat')
    const tab = result.tabs.find((item) => item.id === result.id)
    if (!tab || !(result.created || result.retry)) return
    if (tab.kind === 'file') startRead(tab.id, false)
    else if (tab.status === 'loading') startDiff(tab.id)
  },

  edit: (id, text) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? applyLocalEdit(tab, text) : tab)),
    })),

  save: (id, options) => saveTab(id, options),
  requestClose: (id) => {
    const tab = get().tabs.find((item) => item.id === id)
    if (!tab) return
    if (isDirty(tab)) set({ prompt: { kind: 'close', ids: [id] } })
    else forceClose(id)
  },
  requestCloseAll: (ids) => {
    const tabs = ids ? get().tabs.filter((tab) => ids.includes(tab.id)) : get().tabs
    if (tabs.length === 0) return
    if (tabs.some(isDirty)) set({ prompt: { kind: 'close', ids: tabs.map((tab) => tab.id) } })
    else for (const tab of tabs) forceClose(tab.id)
  },
  confirmClose: (saveFirst) => void confirmClose(saveFirst),
  confirmRefresh: (decision) => void confirmRefresh(decision),
  resolveConflict: (action) => void resolveConflict(action),
  saveCompare: (id, text) => saveCompare(id, text),
  dismissPrompt: () => set({ prompt: null }),
}))

function patchTab(id: string, patch: Partial<Tab>): void {
  useFiles.setState({ tabs: useFiles.getState().tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) })
}

function forceClose(id: string): void {
  const { tabs, activeId, open } = useFiles.getState()
  const result = closeTab(tabs, activeId, id)
  if (result.tabs === tabs) return
  useFiles.setState({ ...result, open: open && result.tabs.length > 0 })
  forgetEditorState(id)
}

/** 保留已显示内容时只置 busy，避免刷新把编辑器卸载、丢掉滚动位置。 */
function startRead(id: string, append: boolean): void {
  const tab = useFiles.getState().tabs.find((item) => item.id === id)
  if (!tab || tab.kind !== 'file' || tab.busy) return
  const revision = tab.revision + 1
  const status: TabStatus = tab.content ? 'ready' : 'loading'
  const image = fileKind(tab.path) === 'image'
  const params: FsReadParams = { path: tab.path }
  if (append) params.offset = tab.loadedBytes
  if (image) params.encoding = 'base64'
  patchTab(id, { revision, busy: true, status, error: undefined, errorCode: undefined })

  void (async () => {
    try {
      const result = await serverCall(tab.targetId, 'fs.read', params)
      const current = useFiles.getState().tabs.find((item) => item.id === id)
      if (!current || current.revision !== revision) return
      useFiles.setState({
        tabs: useFiles.getState().tabs.map((item) => (item.id === id ? mergeRead(item, result, append) : item)),
      })
    } catch (err) {
      const current = useFiles.getState().tabs.find((item) => item.id === id)
      if (!current || current.revision !== revision) return
      useFiles.setState({
        tabs: useFiles.getState().tabs.map((item) => (item.id === id ? failedTab(item, err, '读取文件失败') : item)),
      })
    }
  })()
}

function startDiff(id: string): void {
  const tab = useFiles.getState().tabs.find((item) => item.id === id)
  if (!tab || tab.kind !== 'diff' || tab.mode === 'text' || tab.busy) return
  const revision = tab.revision + 1
  const cwd = tab.cwd ?? dirname(tab.path)
  const params: { cwd: string; path: string; staged?: boolean; commit?: string } = { cwd, path: tab.path }
  if (tab.mode === 'staged') params.staged = true
  if (tab.mode === 'commit' && tab.commit) params.commit = tab.commit
  patchTab(id, {
    revision,
    busy: true,
    status: tab.diff ? 'ready' : 'loading',
    error: undefined,
    errorCode: undefined,
    notice: undefined,
  })

  void (async () => {
    try {
      const result = await serverCall(tab.targetId, 'git.diff', params)
      const current = useFiles.getState().tabs.find((item) => item.id === id)
      if (!current || current.revision !== revision) return
      patchTab(id, {
        status: 'ready',
        busy: false,
        diff: result.diff,
        diffTruncated: result.truncated,
        error: undefined,
        errorCode: undefined,
        notice: undefined,
      })
    } catch (err) {
      const current = useFiles.getState().tabs.find((item) => item.id === id)
      if (!current || current.revision !== revision) return
      const code = errorCodeOf(err)
      // 非 Git 仓库时若请求里带了本轮 diff，退化成展示那段文本而不是空白页。
      if ((code === 'not_repo' || code === 'git_missing') && tab.sourceDiff) {
        patchTab(id, {
          status: 'ready',
          busy: false,
          diff: tab.sourceDiff,
          notice: errorMessage(err, '读取差异失败'),
          errorCode: code,
        })
        return
      }
      useFiles.setState({
        tabs: useFiles.getState().tabs.map((item) => (item.id === id ? failedTab(item, err, '读取差异失败') : item)),
      })
    }
  })()
}

async function saveTab(id: string, options: SaveOptions = {}): Promise<boolean> {
  const tab = useFiles.getState().tabs.find((item) => item.id === id)
  if (!tab || tab.kind !== 'file' || tab.saving || readOnlyReason(tab)) return false
  if (!isDirty(tab) && !options.force && options.expectedMtimeMs === undefined && options.content === undefined) return true

  patchTab(id, markSaving(tab))
  const written = options.content ?? toDiskText(tab.content, tab.eol)
  const params: FsWriteParams = { path: tab.path, content: written }
  if (tab.bom) params.bom = true
  if (tab.sourceEncoding) params.sourceEncoding = tab.sourceEncoding
  if (!options.force) {
    const expected = options.expectedMtimeMs ?? (tab.mtimeMs > 0 ? tab.mtimeMs : undefined)
    if (expected !== undefined) params.expectedMtimeMs = expected
  }

  try {
    const result = await serverCall(tab.targetId, 'fs.write', params)
    const current = useFiles.getState().tabs.find((item) => item.id === id)
    if (!current) return true
    // 保存期间继续输入时，只把"已写盘的那份文本"记为 savedText，dirty 保持为 true。
    patchTab(id, markSaved(current, result.mtimeMs, tab.content))
    return true
  } catch (err) {
    const current = useFiles.getState().tabs.find((item) => item.id === id)
    if (!current) return false
    if (errorCodeOf(err) === 'conflict') {
      patchTab(id, { ...current, saving: false })
      await openConflict(id)
      return false
    }
    patchTab(id, markSaveFailed(current, errorMessage(err, '保存失败')))
    return false
  }
}

async function openConflict(id: string): Promise<void> {
  const tab = useFiles.getState().tabs.find((item) => item.id === id)
  if (!tab) return
  let diskText: string | undefined
  let diskMtimeMs: number | undefined
  try {
    const disk = await serverCall(tab.targetId, 'fs.read', { path: tab.path })
    if (!disk.binary) diskText = disk.content
    diskMtimeMs = disk.mtimeMs
  } catch {
    // 读不到磁盘内容时仍可覆盖 / 重新加载，对比入口按无磁盘文本处理。
  }
  useFiles.setState({
    prompt: { kind: 'conflict', id, message: '文件在打开后被其他程序修改，直接保存会覆盖这些改动。', diskText, diskMtimeMs },
  })
}

async function resolveConflict(action: ConflictAction): Promise<void> {
  const prompt = useFiles.getState().prompt
  if (prompt?.kind !== 'conflict') return
  const tab = useFiles.getState().tabs.find((item) => item.id === prompt.id)
  if (!tab) {
    useFiles.setState({ prompt: null })
    return
  }
  const plan = planConflict(action, { local: tab.content, eol: tab.eol, diskText: prompt.diskText })
  switch (plan.kind) {
    case 'cancel':
      useFiles.setState({ prompt: null })
      return
    case 'overwrite':
      useFiles.setState({ prompt: null })
      await saveTab(prompt.id, { force: true, content: plan.content })
      return
    case 'reload':
      useFiles.setState({ prompt: null })
      startRead(prompt.id, false)
      return
    case 'compare':
      useFiles.setState({
        prompt: { kind: 'compare', id: prompt.id, local: plan.local, disk: plan.disk, diskMtimeMs: prompt.diskMtimeMs },
      })
      return
  }
}

async function saveCompare(id: string, text: string): Promise<void> {
  const prompt = useFiles.getState().prompt
  if (prompt?.kind !== 'compare') return
  const tab = useFiles.getState().tabs.find((item) => item.id === id)
  if (!tab) return
  patchTab(id, applyLocalEdit(tab, text))
  const options: SaveOptions =
    prompt.diskMtimeMs !== undefined ? { expectedMtimeMs: prompt.diskMtimeMs } : { force: true }
  const ok = await saveTab(id, options)
  if (ok) useFiles.setState({ prompt: null })
}

async function confirmClose(saveFirst: boolean): Promise<void> {
  const prompt = useFiles.getState().prompt
  if (prompt?.kind !== 'close') return
  if (saveFirst) {
    for (const id of prompt.ids) {
      const tab = useFiles.getState().tabs.find((item) => item.id === id)
      if (!tab || !isDirty(tab)) continue
      // 保存失败/冲突时保留标签，由对应对话框接管。
      if (!(await saveTab(id))) return
    }
  }
  for (const id of prompt.ids) forceClose(id)
  useFiles.setState({ prompt: null })
}

async function confirmRefresh(decision: 'save' | 'discard' | 'cancel'): Promise<void> {
  const prompt = useFiles.getState().prompt
  if (prompt?.kind !== 'refresh') return
  if (decision === 'cancel') {
    useFiles.setState({ prompt: null })
    return
  }
  if (decision === 'save' && !(await saveTab(prompt.id))) return
  useFiles.setState({ prompt: null })
  startRead(prompt.id, false)
}

/** 已打开文件标签的路径；总管把它与文件树/搜索的监听集合合并后统一 fs.watch。 */
export function getFileWatchPaths(targetId: string): string[] {
  return watchPaths(useFiles.getState().tabs, targetId)
}

/** 打开/关闭文件标签时通知总管重新合并登记 fs.watch（本模块始终不直接调用 fs.watch）。 */
export function subscribeFileWatch(listener: () => void): () => void {
  let previous = watchKey(useFiles.getState().tabs)
  return useFiles.subscribe((state) => {
    const next = watchKey(state.tabs)
    if (next === previous) return
    previous = next
    listener()
  })
}

// 模块加载即订阅：聊天、Git 面板、文件树随时可以 openFile/openDiff，无需先挂载面板。
subscribeOpen((req) => useFiles.getState().handleOpen(req))

onServerEvt('fs.changed', (targetId: string, payload: unknown) => {
  const changed = new Set(changedPaths(payload).map(pathWatchKey))
  if (changed.size === 0) return
  for (const tab of useFiles.getState().tabs) {
    if (tab.kind !== 'file' || tab.targetId !== targetId || !changed.has(pathWatchKey(tab.path))) continue
    // 未改动直接重载（编辑器内整篇替换，光标/滚动不动）；有改动只提示，避免丢本地编辑。
    if (isDirty(tab)) patchTab(tab.id, markDiskChanged(tab))
    else startRead(tab.id, false)
  }
})
