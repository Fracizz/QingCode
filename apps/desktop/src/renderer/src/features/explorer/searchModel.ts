// 快速打开与内容搜索的纯逻辑：模糊排序、命中高亮、结果分组。

import type { FsSearchMatch } from '@qn/protocol'
import { baseName } from './treeModel'

export type NameHit = { path: string }
export type RankedHit<T extends NameHit> = T & { score: number }
export type HighlightPart = { text: string; hit: boolean }
export type ContentGroup = { path: string; hits: FsSearchMatch[] }

/** query 的字符按顺序出现在 text 中时返回下标数组；贪心取最靠前的位置。 */
export function fuzzyIndices(query: string, text: string, caseSensitive = false): number[] | null {
  const needle = caseSensitive ? query : query.toLowerCase()
  const haystack = caseSensitive ? text : text.toLowerCase()
  if (needle === '') return []
  const indices: number[] = []
  let from = 0
  for (const char of needle) {
    let found = -1
    for (let i = from; i < haystack.length; i += 1) {
      if (haystack[i] === char) {
        found = i
        break
      }
    }
    if (found < 0) return null
    indices.push(found)
    from = found + 1
  }
  return indices
}

function matchScore(query: string, text: string, indices: number[], caseSensitive: boolean): number {
  const needle = caseSensitive ? query : query.toLowerCase()
  const haystack = caseSensitive ? text : text.toLowerCase()
  let score = 0
  if (haystack === needle) score += 200
  else if (haystack.indexOf(needle) >= 0) score += 100

  let consecutive = 0
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] === (indices[i - 1] ?? -2) + 1) consecutive += 1
  }
  score += consecutive * 20

  for (const index of indices) {
    const prev = index > 0 ? (haystack[index - 1] ?? '') : ''
    if (index === 0 || /[\\/.\-_ ]/.test(prev)) score += 15
  }
  const span = indices.length > 0 ? (indices[indices.length - 1] ?? 0) - (indices[0] ?? 0) + 1 : 0
  score -= Math.max(0, span - indices.length) * 2
  score -= Math.min(100, Math.round(text.length / 4))
  return score
}

/** 文件名命中优先于路径命中；同类中连续/完整命中优先；路径越短越靠前。 */
export function scoreNameHit(query: string, path: string, caseSensitive = false): number | null {
  const name = baseName(path)
  const inName = fuzzyIndices(query, name, caseSensitive)
  if (inName) {
    return 1_000_000 + matchScore(query, name, inName, caseSensitive) * 10 - path.length
  }
  const inPath = fuzzyIndices(query, path, caseSensitive)
  if (!inPath) return null
  return matchScore(query, path, inPath, caseSensitive) * 10 - path.length
}

export function rankNameHits<T extends NameHit>(
  query: string,
  hits: T[],
  caseSensitive = false,
  limit = 100,
): RankedHit<T>[] {
  const needle = query.trim()
  if (needle === '') return hits.slice(0, limit).map((hit) => ({ ...hit, score: 0 }))
  const ranked: RankedHit<T>[] = []
  for (const hit of hits) {
    const score = scoreNameHit(needle, hit.path, caseSensitive)
    if (score === null) continue
    ranked.push({ ...hit, score })
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
  )
  return ranked.slice(0, limit)
}

/** 把一行文本切成命中/未命中片段，供内容搜索结果高亮。 */
export function highlightParts(
  text: string,
  query: string,
  caseSensitive = false,
): HighlightPart[] {
  const needle = (caseSensitive ? query : query.toLowerCase()).trim()
  if (needle === '' || text === '') return [{ text, hit: false }]
  const haystack = caseSensitive ? text : text.toLowerCase()
  const parts: HighlightPart[] = []
  let from = 0
  while (from < text.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) {
      parts.push({ text: text.slice(from), hit: false })
      break
    }
    if (index > from) parts.push({ text: text.slice(from, index), hit: false })
    parts.push({ text: text.slice(index, index + needle.length), hit: true })
    from = index + needle.length
  }
  return parts
}

/** 内容搜索结果按文件分组，组内按行号/列号升序。 */
export function groupContentMatches(matches: FsSearchMatch[]): ContentGroup[] {
  const groups = new Map<string, FsSearchMatch[]>()
  for (const match of matches) {
    const bucket = groups.get(match.path)
    if (bucket) bucket.push(match)
    else groups.set(match.path, [match])
  }
  return [...groups.entries()]
    .map(([path, hits]) => ({
      path,
      hits: [...hits].sort(
        (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
      ),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
