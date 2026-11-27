// 命令搜索：标题 / 分类 / 关键字的模糊匹配与打分，纯逻辑。

export type FuzzyHit = {
  score: number
  /** 命中字符在原文中的下标（升序），用于高亮 */
  positions: number[]
}

const isWordStart = (text: string, index: number): boolean => {
  if (index === 0) return true
  const prev = text[index - 1]!
  const cur = text[index]!
  if (/[\s\-_.:/\\()[\]]/.test(prev)) return true
  // camelCase 边界
  if (/[a-z]/.test(prev) && /[A-Z]/.test(cur)) return true
  // 中英文交界也算词首，"打开Git" 里的 G
  return /[一-鿿]/.test(prev) !== /[一-鿿]/.test(cur)
}

/** 从 start 起贪心找子序列并打分；连续命中与词首命中加分，越靠前越好。 */
function subsequenceFrom(text: string, lower: string, query: string, start: number): FuzzyHit | null {
  const positions: number[] = []
  let score = 0
  let qi = 0
  let prevPos = -2
  for (let i = start; i < lower.length && qi < query.length; i++) {
    if (lower[i] !== query[qi]) continue
    let charScore = 1
    if (i === prevPos + 1) charScore += 5
    if (isWordStart(text, i)) charScore += 4
    score += charScore
    positions.push(i)
    prevPos = i
    qi++
  }
  if (qi < query.length) return null
  // 跨度越大越松散，扣分；首字符位置越靠后扣分
  const span = positions[positions.length - 1]! - positions[0]! + 1
  score -= (span - query.length) * 0.5
  score -= positions[0]! * 0.2
  return { score, positions }
}

/**
 * 不区分大小写的模糊匹配：先找连续子串（得分最高，词首 / 开头再加分），
 * 否则在首字符的每个出现位置尝试子序列匹配，取最高分。查询为空返回 0 分空命中。
 */
export function fuzzyMatch(text: string, rawQuery: string): FuzzyHit | null {
  const query = rawQuery.toLowerCase()
  if (!query) return { score: 0, positions: [] }
  const lower = text.toLowerCase()

  const index = lower.indexOf(query)
  if (index !== -1) {
    // 优先取词首处的子串，"git" 在 "打开 Git 面板" 里命中 G 而非某个单词中间
    let best = index
    for (let i = index; i !== -1; i = lower.indexOf(query, i + 1)) {
      if (isWordStart(text, i)) {
        best = i
        break
      }
    }
    let score = 100 + query.length * 6 - best * 0.5
    if (best === 0) score += 30
    else if (isWordStart(text, best)) score += 15
    if (query.length === lower.length) score += 20
    return { score, positions: Array.from({ length: query.length }, (_, k) => best + k) }
  }

  let bestHit: FuzzyHit | null = null
  for (let i = lower.indexOf(query[0]!); i !== -1; i = lower.indexOf(query[0]!, i + 1)) {
    const hit = subsequenceFrom(text, lower, query, i)
    if (!hit) break // 更靠后的起点只会更难匹配
    if (!bestHit || hit.score > bestHit.score) bestHit = hit
  }
  return bestHit
}

export type CommandMatch = {
  score: number
  titlePositions: number[]
  categoryPositions: number[]
}

/** 查询按空白切成多个词，每个词都必须在标题、分类或关键字之一中命中；标题权重最高。 */
export function matchCommandText(
  fields: { title: string; category?: string; keywords?: readonly string[] },
  rawQuery: string,
): CommandMatch | null {
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean)
  const titleSet = new Set<number>()
  const categorySet = new Set<number>()
  let score = 0
  for (const token of tokens) {
    const inTitle = fuzzyMatch(fields.title, token)
    const inCategory = fields.category ? fuzzyMatch(fields.category, token) : null
    let inKeywords: FuzzyHit | null = null
    for (const keyword of fields.keywords ?? []) {
      const hit = fuzzyMatch(keyword, token)
      if (hit && (!inKeywords || hit.score > inKeywords.score)) inKeywords = hit
    }
    const candidates = [
      inTitle ? { kind: 'title' as const, score: inTitle.score, hit: inTitle } : null,
      inCategory ? { kind: 'category' as const, score: inCategory.score * 0.6, hit: inCategory } : null,
      inKeywords ? { kind: 'keyword' as const, score: inKeywords.score * 0.5, hit: inKeywords } : null,
    ].filter((item) => item !== null)
    if (candidates.length === 0) return null
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a))
    score += best.score
    if (best.kind === 'title') best.hit.positions.forEach((p) => titleSet.add(p))
    else if (best.kind === 'category') best.hit.positions.forEach((p) => categorySet.add(p))
  }
  return {
    score,
    titlePositions: [...titleSet].sort((a, b) => a - b),
    categoryPositions: [...categorySet].sort((a, b) => a - b),
  }
}

export type HighlightSegment = { text: string; hit: boolean }

/** 把命中下标切成连续的高亮/非高亮片段，渲染层直接 map。 */
export function splitHighlight(text: string, positions: readonly number[]): HighlightSegment[] {
  if (positions.length === 0) return text ? [{ text, hit: false }] : []
  const marks = new Set(positions)
  const segments: HighlightSegment[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = marks.has(i)
    const last = segments[segments.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else segments.push({ text: text[i]!, hit })
  }
  return segments
}
