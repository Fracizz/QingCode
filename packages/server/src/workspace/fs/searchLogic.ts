import path from 'node:path'
import type { FsSearchMatch, FsSearchResultEvt } from '@qn/protocol'
import { truncateText } from './logic'

export const BATCH_MAX_MATCHES = 200
export const BATCH_MIN_INTERVAL_MS = 100

/** rg --files 在 Windows 会输出 `.\\a.ts`，统一成相对 root 的 `/` 形式。 */
export function cleanRelPath(relative: string): string {
  let value = relative.replace(/\\/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只认 type=match 的 rg --json 行，其他事件（begin/end/summary）与坏行忽略。 */
export function parseRgMatch(line: string, root: string): FsSearchMatch | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.type !== 'match' || !isRecord(parsed.data)) return null
  const data = parsed.data
  const pathField = data.path
  const pathText =
    typeof pathField === 'string'
      ? pathField
      : isRecord(pathField) && typeof pathField.text === 'string'
        ? pathField.text
        : ''
  if (pathText.length === 0) return null

  const absolute = path.isAbsolute(pathText) ? pathText : path.resolve(root, cleanRelPath(pathText))
  const lines = data.lines
  const rawText = isRecord(lines) && typeof lines.text === 'string' ? lines.text : ''
  const lineNumber = typeof data.line_number === 'number' ? data.line_number : undefined
  const submatches = Array.isArray(data.submatches) ? data.submatches : []
  const first = submatches[0]
  const start = isRecord(first) && typeof first.start === 'number' ? first.start : 0
  return {
    path: absolute,
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    column: start + 1,
    text: truncateText(rawText),
  }
}

/** 每批最多 200 条，或距上次推送 ≥100ms；两条件都满足时立即推。 */
export function shouldFlushBatch(
  size: number,
  elapsedMs: number,
  maxSize = BATCH_MAX_MATCHES,
  intervalMs = BATCH_MIN_INTERVAL_MS,
): boolean {
  return size >= maxSize || (size > 0 && elapsedMs >= intervalMs)
}

/** 与 IO 解耦的推送节流器：now/emit 可注入，便于单测。 */
export class SearchBatcher {
  private batch: FsSearchMatch[] = []
  private total = 0
  private lastFlushMs: number
  private finished = false

  constructor(
    private readonly searchId: string,
    private readonly maxResults: number,
    private readonly emit: (evt: FsSearchResultEvt) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastFlushMs = this.now()
  }

  get count(): number {
    return this.total
  }

  /** 返回 true 表示已到 maxResults，调用方应立即停止遍历。 */
  push(match: FsSearchMatch): boolean {
    if (this.finished || this.total >= this.maxResults) return true
    this.batch.push(match)
    this.total++
    if (shouldFlushBatch(this.batch.length, this.now() - this.lastFlushMs)) this.flush()
    return this.total >= this.maxResults
  }

  flush(): void {
    if (this.batch.length === 0) return
    const matches = this.batch
    this.batch = []
    this.lastFlushMs = this.now()
    this.emit({ searchId: this.searchId, matches, done: false })
  }

  finish(truncated = false, error?: string): void {
    if (this.finished) return
    this.finished = true
    this.flush()
    this.emit({
      searchId: this.searchId,
      matches: [],
      done: true,
      ...(truncated ? { truncated: true } : {}),
      ...(error !== undefined && error !== '' ? { error } : {}),
    })
  }
}
