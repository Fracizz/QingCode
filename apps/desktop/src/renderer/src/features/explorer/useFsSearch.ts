// fs.search 的生命周期：防抖、取消旧查询、按 searchId 过滤流式事件。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FsSearchMode, FsSearchMatch, FsSearchResultEvt } from '@qn/protocol'
import { onServerEvt, serverCall } from '../workspace/serverCall'
import { describeWorkspaceError } from './treeModel'

export type FsSearchState = {
  matches: FsSearchMatch[]
  done: boolean
  truncated: boolean
  error: string | null
  searching: boolean
}

export type FsSearchOptions = {
  root: string
  query: string
  mode: FsSearchMode
  caseSensitive?: boolean
  glob?: string
  debounceMs?: number
  enabled?: boolean
  maxResults?: number
}

const EMPTY: FsSearchState = {
  matches: [],
  done: false,
  truncated: false,
  error: null,
  searching: false,
}

const MAX_BUFFERED_IDS = 8

export function useFsSearch(targetId: string, options: FsSearchOptions): FsSearchState {
  const {
    root,
    query,
    mode,
    caseSensitive = false,
    glob = '',
    debounceMs = 150,
    enabled = true,
    maxResults = 500,
  } = options
  const [state, setState] = useState<FsSearchState>(EMPTY)
  const activeId = useRef<string | null>(null)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // server 可能在 fs.search 的响应到达前就推送首批结果，按 searchId 暂存再回放。
  const buffered = useRef<Map<string, FsSearchResultEvt[]>>(new Map())
  const applyRef = useRef<(payload: FsSearchResultEvt) => void>(() => {})

  applyRef.current = (payload) => {
    setState((previous) => ({
      matches: [...previous.matches, ...(payload.matches ?? [])].slice(0, 5000),
      done: payload.done === true,
      truncated: previous.truncated || payload.truncated === true,
      error: payload.error
        ? describeWorkspaceError({ message: payload.error }, '搜索失败')
        : previous.error,
      searching: payload.done !== true,
    }))
    if (payload.done === true) activeId.current = null
  }

  const cancelActive = useCallback(() => {
    const id = activeId.current
    activeId.current = null
    if (id) void serverCall(targetId, 'fs.searchCancel', { searchId: id }).catch(() => {})
  }, [targetId])

  useEffect(() => {
    if (!enabled) return
    return onServerEvt<FsSearchResultEvt>('fs.searchResult', (eventTargetId, payload) => {
      if (eventTargetId !== targetId || !payload || typeof payload.searchId !== 'string') return
      if (payload.searchId === activeId.current) {
        applyRef.current(payload)
        return
      }
      const list = buffered.current.get(payload.searchId) ?? []
      list.push(payload)
      buffered.current.set(payload.searchId, list)
      if (buffered.current.size > MAX_BUFFERED_IDS) {
        const oldest = buffered.current.keys().next().value
        if (oldest !== undefined) buffered.current.delete(oldest)
      }
    })
  }, [enabled, targetId])

  const trimmed = query.trim()
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const current = ++generation.current
    if (!enabled || trimmed === '') {
      cancelActive()
      setState(EMPTY)
      return
    }
    setState({ ...EMPTY, searching: true })
    timer.current = setTimeout(() => {
      void (async () => {
        cancelActive()
        // 防抖窗口内旧查询仍可能推送结果，开始新查询时清空一次。
        setState({ ...EMPTY, searching: true })
        try {
          const { searchId } = await serverCall(targetId, 'fs.search', {
            root,
            query: trimmed,
            mode,
            caseSensitive,
            ...(glob.trim() ? { glob: glob.trim() } : {}),
            maxResults,
          })
          if (current !== generation.current) {
            void serverCall(targetId, 'fs.searchCancel', { searchId }).catch(() => {})
            return
          }
          activeId.current = searchId
          for (const payload of buffered.current.get(searchId) ?? []) applyRef.current(payload)
          buffered.current.delete(searchId)
        } catch (err) {
          if (current !== generation.current) return
          setState({
            ...EMPTY,
            done: true,
            error: describeWorkspaceError(err, '搜索失败'),
          })
        }
      })()
    }, debounceMs)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [
    targetId,
    root,
    trimmed,
    mode,
    caseSensitive,
    glob,
    maxResults,
    debounceMs,
    enabled,
    cancelActive,
  ])

  useEffect(
    () => () => {
      generation.current += 1
      if (timer.current) clearTimeout(timer.current)
      cancelActive()
    },
    [cancelActive],
  )

  return state
}
