// `@` 引用文件的纯逻辑：触发判定、文本替换、候选排序。搜索 IO 走 explorer 的 useFsSearch。

import type { FsSearchMatch } from '@qn/protocol'
import { scoreNameHit } from '../explorer/searchModel'
import { baseName, detectPathStyle, relativePath } from '../explorer/treeModel'

export type MentionToken = { query: string; start: number; end: number }

export type MentionCandidate = {
  /** 绝对路径（目标机上）。 */
  path: string
  /** 相对项目根、统一用 `/` 分隔，插入文本时用它。 */
  relative: string
  name: string
  score: number
}

/**
 * 光标前的 `@片段`：`@` 必须在行首或空白之后（排除邮箱 a@b.com），光标停在词尾才触发。
 * 已经插入过的带引号引用（`@"a b.ts"`）不再弹出候选。
 */
export function mentionToken(value: string, caret: number): MentionToken | null {
  const before = value.slice(0, caret)
  const after = value.slice(caret)
  if (after && !/^\s/.test(after)) return null
  const match = /(?:^|\s)@([^\s@"]*)$/.exec(before)
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: before.length - query.length - 1, end: caret }
}

/**
 * fs.search 的 name 模式只按文件名做子串匹配，带目录的查询（`src/ap`）只把最后一段发给服务端，
 * 目录部分交给客户端按相对路径模糊过滤。
 */
export function serverQuery(query: string): string {
  const parts = query.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').trim()
}

/** 插入文本的形式：`@相对路径`；含空白时加引号，避免 Agent 把路径截断。 */
export function formatMention(relative: string): string {
  const normalized = relative.replace(/\\/g, '/')
  return /\s/.test(normalized) ? `@"${normalized}"` : `@${normalized}`
}

/** 用选中的路径替换当前 `@片段`，后面补一个空格方便继续输入；返回新文本与光标位置。 */
export function applyMention(
  value: string,
  token: MentionToken,
  relative: string,
): { value: string; caret: number } {
  const left = value.slice(0, token.start)
  const right = value.slice(token.end)
  const inserted = formatMention(relative)
  const spacer = /^\s/.test(right) ? '' : ' '
  const next = `${left}${inserted}${spacer}${right}`
  // 光标总是落在空白之后：停在 `@路径` 词尾会被 mentionToken 再次识别，菜单又弹出来。
  return { value: next, caret: left.length + inserted.length + 1 }
}

/** 搜索结果 → 候选：只保留项目根内的文件，按相对路径模糊打分（文件名命中优先），去重后截断。 */
export function rankMentionCandidates(
  query: string,
  matches: FsSearchMatch[],
  root: string,
  limit = 50,
): MentionCandidate[] {
  const style = detectPathStyle(root)
  const needle = query.trim().replace(/\\/g, '/')
  const seen = new Set<string>()
  const out: MentionCandidate[] = []
  for (const match of matches) {
    const rel = relativePath(root, match.path, style)
    // 不在根内时 relativePath 原样返回绝对路径；根本身返回空串。两者都不是可引用的项目文件。
    if (!rel || rel === match.path) continue
    const relative = rel.replace(/\\/g, '/')
    if (seen.has(relative)) continue
    seen.add(relative)
    const score = needle ? scoreNameHit(needle, relative) : 0
    if (score === null) continue
    out.push({ path: match.path, relative, name: baseName(relative), score })
  }
  out.sort(
    (a, b) =>
      b.score - a.score || a.relative.length - b.relative.length || a.relative.localeCompare(b.relative),
  )
  return out.slice(0, limit)
}
