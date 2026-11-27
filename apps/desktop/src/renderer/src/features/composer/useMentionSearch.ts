import { useMemo } from 'react'
import { useFsSearch } from '../explorer/useFsSearch'
import { rankMentionCandidates, serverQuery, type MentionCandidate } from './mentions'

export type MentionSearch = { items: MentionCandidate[]; searching: boolean; error: string | null }

/** `@` 候选：复用 explorer 的 fs.search 生命周期（防抖、取消旧查询），结果按相对路径排序。 */
export function useMentionSearch(
  targetId: string | null,
  root: string | null,
  query: string | null,
): MentionSearch {
  const enabled = query !== null && !!targetId && !!root
  const search = useFsSearch(targetId ?? '', {
    root: root ?? '',
    query: enabled ? serverQuery(query) : '',
    mode: 'name',
    debounceMs: 120,
    enabled,
    maxResults: 300,
  })
  const items = useMemo(
    () => (enabled && root && query !== null ? rankMentionCandidates(query, search.matches, root, 50) : []),
    [enabled, query, root, search.matches],
  )
  return { items, searching: search.searching, error: search.error }
}
