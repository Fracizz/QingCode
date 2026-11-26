import { create } from 'zustand'
import type { FsReadParams } from '@qn/protocol'
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

export type FilesState = {
  tabs: Tab[]
  activeId: string | null
  /** 面板是否展开；打开任何文件/差异时自动置 true。 */
  open: boolean
  setOpen: (open: boolean) => void
  activate: (id: string) => void
  close: (id: string) => void
  closeAll: () => void
  setView: (id: string, view: TabView) => void
  refresh: (id: string) => void
  loadMore: (id: string) => void
  /** 仅供打开请求总线回调使用。 */
  handleOpen: (req: OpenRequest) => void
}

let nextTabId = 1

export const useFiles = create<FilesState>((set, get) => ({
  tabs: [],
  activeId: null,
  open: false,

  setOpen: (open) => set({ open }),
  activate: (id) => set({ activeId: id, open: true }),
  close: (id) => set((state) => closeTab(state.tabs, state.activeId, id)),
  closeAll: () => set({ tabs: [], activeId: null }),
  setView: (id, view) =>
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, view } : tab)) })),

  refresh: (id) => {
    const tab = get().tabs.find((item) => item.id === id)
    if (!tab) return
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
    set({ tabs: result.tabs, activeId: result.id, open: true })
    const tab = result.tabs.find((item) => item.id === result.id)
    if (!tab || !(result.created || result.retry)) return
    if (tab.kind === 'file') startRead(tab.id, false)
    else if (tab.status === 'loading') startDiff(tab.id)
  },
}))

function patchTab(id: string, patch: Partial<Tab>): void {
  useFiles.setState({ tabs: useFiles.getState().tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) })
}

/** 保留已显示内容时只置 busy，避免刷新把 CodeView 卸载、丢掉滚动位置。 */
function startRead(id: string, append: boolean): void {
  const tab = useFiles.getState().tabs.find((item) => item.id === id)
  if (!tab || tab.kind !== 'file' || tab.busy) return
  const revision = tab.revision + 1
  const status: TabStatus = tab.content ? 'ready' : 'loading'
  const image = fileKind(tab.path) === 'image'
  const params: FsReadParams = { path: tab.path }
  if (append) params.offset = tab.loadedBytes
  if (image) params.encoding = 'base64'
  // 保留旧内容：刷新/外部变更期间 CodeView 不卸载，滚动位置也就不会丢。
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
    if (tab.kind === 'file' && tab.targetId === targetId && changed.has(pathWatchKey(tab.path))) {
      startRead(tab.id, false)
    }
  }
})
