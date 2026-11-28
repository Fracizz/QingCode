// 按 targetId + root 分仓的文件树状态。IO 集中在这里，纯逻辑都在 treeModel.ts。

import { create } from 'zustand'
import type { FsChangedEvt } from '@qn/protocol'
import { t } from '@qn/codex-client'
import { call } from '../../lib/backend'
import { onServerEvt, serverCall } from '../workspace/serverCall'
import {
  collapseAll,
  createTreeState,
  describeWorkspaceError,
  detectPathStyle,
  dirsToRefresh,
  isExpanded,
  isHiddenName,
  isSamePath,
  isWithinPath,
  joinPath,
  parentPath,
  parseListResult,
  pruneDirs,
  relativePath,
  setDirError,
  setDirLoading,
  setDirReady,
  setShowHidden,
  toggleExpanded,
  validateEntryName,
  type TreeState,
} from './treeModel'

export type ExplorerScope = {
  targetId: string
  root: string
  tree: TreeState
  error: string | null
}

export type ExplorerActions = {
  init(targetId: string, root: string): void
  loadDir(targetId: string, root: string, path: string): Promise<void>
  toggle(targetId: string, root: string, path: string): void
  setHidden(targetId: string, root: string, value: boolean): void
  collapse(targetId: string, root: string): void
  refresh(targetId: string, root: string, path?: string): Promise<void>
  locateFile(targetId: string, root: string, path: string): Promise<{ path: string } | { error: string }>
  createEntry(
    targetId: string,
    root: string,
    parent: string,
    name: string,
    kind: 'file' | 'dir',
  ): Promise<string | null>
  renameEntry(targetId: string, root: string, from: string, name: string): Promise<string | null>
  deleteEntry(targetId: string, root: string, path: string, recursive: boolean): Promise<string | null>
  clearError(targetId: string, root: string): void
  refreshChanged(targetId: string, paths: string[]): void
}

export type ExplorerStore = {
  scopes: Record<string, ExplorerScope | undefined>
  /** 展开集合变化时递增，供总管重新登记 fs.watch */
  watchRevision: number
  actions: ExplorerActions
}

const STORAGE_PREFIX = 'qn-explorer:'
const pendingDirs = new Map<string, Promise<void>>()

export function explorerScopeKey(targetId: string, root: string): string {
  return JSON.stringify([targetId, root])
}

const dirRequestKey = (scope: string, path: string): string => JSON.stringify([scope, path])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function readPersisted(targetId: string, root: string): { expanded: string[]; showHidden: boolean } {
  const empty = { expanded: [] as string[], showHidden: false }
  try {
    if (typeof localStorage === 'undefined') return empty
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${targetId}:${root}`)
    if (!raw) return empty
    const value: unknown = JSON.parse(raw)
    // 兼容早期只存展开数组的格式。
    const record: unknown = Array.isArray(value) ? { expanded: value } : value
    if (!isRecord(record)) return empty
    const expanded = Array.isArray(record.expanded)
      ? record.expanded.filter((item): item is string => typeof item === 'string')
      : []
    return { expanded, showHidden: record.showHidden === true }
  } catch {
    // 本地状态损坏时按空状态重建，不让面板打不开。
    return empty
  }
}

function writePersisted(targetId: string, root: string, tree: TreeState): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(
      `${STORAGE_PREFIX}${targetId}:${root}`,
      JSON.stringify({ expanded: tree.expanded, showHidden: tree.showHidden }),
    )
  } catch {
    // 隐私模式 / 配额不足时只是不持久化。
  }
}

function expandedChanged(a: string[], b: string[]): boolean {
  const left = [...a].sort()
  const right = [...b].sort()
  return left.length !== right.length || left.some((item, index) => item !== right[index])
}

export const useExplorer = create<ExplorerStore>((set, get) => {
  const setTree = (key: string, tree: TreeState): void => {
    set((state) => {
      const scope = state.scopes[key]
      if (!scope) return state
      return {
        scopes: { ...state.scopes, [key]: { ...scope, tree } },
        watchRevision:
          state.watchRevision + (expandedChanged(scope.tree.expanded, tree.expanded) ? 1 : 0),
      }
    })
  }

  const changeTree = (key: string, fn: (tree: TreeState) => TreeState): void => {
    const scope = get().scopes[key]
    if (scope) setTree(key, fn(scope.tree))
  }

  const setScopeError = (key: string, error: string | null): void => {
    set((state) => {
      const scope = state.scopes[key]
      if (!scope) return state
      return { scopes: { ...state.scopes, [key]: { ...scope, error } } }
    })
  }

  const loadDir = (targetId: string, root: string, path: string): Promise<void> => {
    const key = explorerScopeKey(targetId, root)
    if (!get().scopes[key]) return Promise.resolve()
    const requestKey = dirRequestKey(key, path)
    const request = Promise.resolve().then(async () => {
      try {
        // fs.list 不在 WorkspaceMethods 里，按任务卡约定直接透传 backend。
        const result = await call('server.req', { targetId, method: 'fs.list', params: { path } })
        // 并发刷新时只接受最后一次响应，避免旧数据覆盖新数据。
        if (pendingDirs.get(requestKey) !== request) return
        const parsed = parseListResult(result)
        changeTree(key, (tree) => setDirReady(tree, path, parsed.entries, parsed.truncated))
        if (get().scopes[key]?.error) setScopeError(key, null)
      } catch (err) {
        if (pendingDirs.get(requestKey) !== request) return
        const message = describeWorkspaceError(err, t('读取目录失败'))
        changeTree(key, (tree) => setDirError(tree, path, message))
        setScopeError(key, message)
      } finally {
        if (pendingDirs.get(requestKey) === request) pendingDirs.delete(requestKey)
      }
    })
    pendingDirs.set(requestKey, request)
    changeTree(key, (tree) => setDirLoading(tree, path))
    return request
  }

  const refresh = async (targetId: string, root: string, path?: string): Promise<void> => {
    const key = explorerScopeKey(targetId, root)
    const scope = get().scopes[key]
    if (!scope) return
    const dirs = path ? [path] : [root, ...Object.keys(scope.tree.dirs)]
    await Promise.all([...new Set(dirs)].map((dir) => get().actions.loadDir(targetId, root, dir)))
  }

  const actions: ExplorerActions = {
    init(targetId, root) {
      const key = explorerScopeKey(targetId, root)
      if (get().scopes[key]) return
      const saved = readPersisted(targetId, root)
      const style = detectPathStyle(root)
      const expanded = saved.expanded.filter(
        (item) => isSamePath(item, root, style) || isWithinPath(item, root, style),
      )
      set((state) => ({
        scopes: {
          ...state.scopes,
          [key]: {
            targetId,
            root,
            tree: { ...createTreeState(saved.showHidden), expanded },
            error: null,
          },
        },
        watchRevision: state.watchRevision + 1,
      }))
      void get().actions.loadDir(targetId, root, root)
    },

    loadDir,

    toggle(targetId, root, path) {
      const key = explorerScopeKey(targetId, root)
      const scope = get().scopes[key]
      if (!scope) return
      const style = detectPathStyle(root)
      const next = toggleExpanded(scope.tree, path, style)
      writePersisted(targetId, root, next)
      setTree(key, next)
      if (isExpanded(next, path, style) && !next.dirs[path]) {
        void get().actions.loadDir(targetId, root, path)
      }
    },

    setHidden(targetId, root, value) {
      const key = explorerScopeKey(targetId, root)
      const scope = get().scopes[key]
      if (!scope) return
      const next = setShowHidden(scope.tree, value)
      writePersisted(targetId, root, next)
      setTree(key, next)
    },

    collapse(targetId, root) {
      const key = explorerScopeKey(targetId, root)
      const scope = get().scopes[key]
      if (!scope) return
      const next = collapseAll(scope.tree)
      writePersisted(targetId, root, next)
      setTree(key, next)
    },

    refresh,

    async locateFile(targetId, root, path) {
      const style = detectPathStyle(root)
      if (!isWithinPath(path, root, style)) return { error: t('文件不在当前项目内') }
      const names = relativePath(root, path, style).split(style === 'windows' ? '\\' : '/')
      if (names.some((name) => name === '.' || name === '..')) return { error: t('文件不在当前项目内') }
      const key = explorerScopeKey(targetId, root)
      const ancestors: string[] = []
      let dir = root
      for (const [index, name] of names.entries()) {
        const requestKey = dirRequestKey(key, dir)
        const matchesName = (item: { name: string }) => style === 'windows'
          ? item.name.toLowerCase() === name.toLowerCase()
          : item.name === name
        const cached = get().scopes[key]?.tree.dirs[dir]
        if (!pendingDirs.has(requestKey) && (cached?.status !== 'ready' || !cached.entries.some(matchesName))) {
          void loadDir(targetId, root, dir)
        }
        // 初始化或监听刷新已经在列目录时，等最新的一次响应再检查子项。
        let pending: Promise<void> | undefined
        while ((pending = pendingDirs.get(requestKey))) await pending
        const tree = get().scopes[key]?.tree
        const listing = tree?.dirs[dir]
        if (!tree || listing?.status !== 'ready') return { error: t('定位文件时无法读取目录') }
        const entry = listing.entries.find(matchesName)
        if (!entry) return { error: listing.truncated ? t('目录列表已截断，无法定位文件') : t('未在文件树中找到文件') }
        if (!tree.showHidden && isHiddenName(entry.name)) return { error: t('请先显示隐藏文件再定位') }
        if (index < names.length - 1 && entry.kind === 'file') return { error: t('未在文件树中找到文件') }
        dir = joinPath(dir, entry.name, style)
        if (index < names.length - 1) ancestors.push(dir)
      }
      const tree = get().scopes[key]?.tree
      if (!tree) return { error: t('未在文件树中找到文件') }
      const next = { ...tree, expanded: [...tree.expanded, ...ancestors.filter((path) => !isExpanded(tree, path, style))] }
      if (next.expanded.length !== tree.expanded.length) {
        writePersisted(targetId, root, next)
        setTree(key, next)
      }
      return { path: dir }
    },

    async createEntry(targetId, root, parent, name, kind) {
      const style = detectPathStyle(root)
      const problem = validateEntryName(name, style)
      if (problem) return problem
      const path = joinPath(parent, name, style)
      const fallback = kind === 'file' ? t('新建文件失败') : t('新建文件夹失败')
      try {
        if (kind === 'file') await serverCall(targetId, 'fs.createFile', { path })
        else await serverCall(targetId, 'fs.mkdir', { path })
      } catch (err) {
        return describeWorkspaceError(err, fallback)
      }
      await refresh(targetId, root, parent)
      return null
    },

    async renameEntry(targetId, root, from, name) {
      const style = detectPathStyle(root)
      const problem = validateEntryName(name, style)
      if (problem) return problem
      const parent = parentPath(from, style)
      const to = joinPath(parent, name, style)
      if (isSamePath(to, from, style)) return null
      try {
        await serverCall(targetId, 'fs.rename', { from, to })
      } catch (err) {
        return describeWorkspaceError(err, t('重命名失败'))
      }
      changeTree(explorerScopeKey(targetId, root), (tree) => pruneDirs(tree, from, style))
      await refresh(targetId, root, parent)
      return null
    },

    async deleteEntry(targetId, root, path, recursive) {
      try {
        await serverCall(targetId, 'fs.delete', { path, ...(recursive ? { recursive: true } : {}) })
      } catch (err) {
        return describeWorkspaceError(err, t('删除失败'))
      }
      const style = detectPathStyle(root)
      changeTree(explorerScopeKey(targetId, root), (tree) => pruneDirs(tree, path, style))
      await refresh(targetId, root, parentPath(path, style))
      return null
    },

    clearError(targetId, root) {
      setScopeError(explorerScopeKey(targetId, root), null)
    },

    refreshChanged(targetId, paths) {
      for (const scope of Object.values(get().scopes)) {
        if (!scope || scope.targetId !== targetId) continue
        const style = detectPathStyle(scope.root)
        const dirs = dirsToRefresh(
          scope.root,
          [...Object.keys(scope.tree.dirs), ...scope.tree.expanded],
          scope.tree.expanded,
          paths,
          style,
        )
        for (const dir of dirs) void get().actions.loadDir(targetId, scope.root, dir)
      }
    },
  }

  return { scopes: {}, watchRevision: 0, actions }
})

// 只刷新受影响目录，避免每次远端变化都全量重列整棵树。
onServerEvt<FsChangedEvt>('fs.changed', (targetId, payload) => {
  const paths = Array.isArray(payload?.paths)
    ? payload.paths.filter((item): item is string => typeof item === 'string')
    : []
  if (paths.length > 0) useExplorer.getState().actions.refreshChanged(targetId, paths)
})

/**
 * fs.watch 是"每连接一个监听集合、全量替换"，本模块不直接登记：
 * 返回该目标已展开目录（含项目根），由总管与 T18 的 getFileWatchPaths 合并后统一调用。
 */
export function getExplorerWatchPaths(targetId?: string): string[] {
  const paths = new Set<string>()
  for (const scope of Object.values(useExplorer.getState().scopes)) {
    if (!scope || (targetId !== undefined && scope.targetId !== targetId)) continue
    paths.add(scope.root)
    for (const dir of scope.tree.expanded) paths.add(dir)
  }
  return [...paths].sort()
}

/** 展开集合变化时通知总管重新合并登记 fs.watch。 */
export function subscribeExplorerWatch(listener: () => void): () => void {
  return useExplorer.subscribe((state, previous) => {
    if (state.watchRevision !== previous.watchRevision) listener()
  })
}
