import { BridgeRpcError } from './errors'
import { asRecord, isRecord, scalarText, type Json } from './v2'

const PAGE_BYTES = 768 * 1024
const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 100
const SNAPSHOT_MS = 15_000

function invalidCursor(): never {
  throw new BridgeRpcError(-32602, '历史分页游标无效，请重新打开会话')
}

function encodeCursor(scope: string, id: string): string {
  return Buffer.from(JSON.stringify([scope, id])).toString('base64url')
}

function cursorAnchor(cursor: unknown, scope: string, allowItemAnchor: boolean): { id: string; inclusive: boolean } {
  const anchor = asRecord(cursor)
  if (allowItemAnchor && anchor?.type === 'item' && typeof anchor.itemId === 'string') {
    return { id: anchor.itemId, inclusive: false }
  }
  if (typeof cursor !== 'string' || cursor.length > 16_384) return invalidCursor()
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return invalidCursor()
  }
  if (!Array.isArray(value) || value[0] !== scope || typeof value[1] !== 'string') {
    return invalidCursor()
  }
  return { id: value[1], inclusive: true }
}

function page<T>(
  entries: readonly T[],
  idFor: (entry: T) => string,
  project: (entry: T) => Json,
  params: Json,
  scope: string,
  defaultDirection: 'asc' | 'desc',
  allowItemAnchor = false,
): Json {
  const direction = params.sortDirection ?? defaultDirection
  if (direction !== 'asc' && direction !== 'desc') {
    throw new BridgeRpcError(-32602, '历史分页排序无效')
  }
  const step = direction === 'desc' ? -1 : 1
  const limit = params.limit ?? DEFAULT_PAGE_LIMIT
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new BridgeRpcError(-32602, '历史分页大小无效')
  }
  let index = step === -1 ? entries.length - 1 : 0
  if (params.cursor != null) {
    const anchor = cursorAnchor(params.cursor, scope, allowItemAnchor)
    const found = entries.findIndex((entry) => idFor(entry) === anchor.id)
    if (found < 0) return invalidCursor()
    index = found + (anchor.inclusive ? 0 : step)
  }
  const first = index
  const data: Json[] = []
  let bytes = 0
  const pageLimit = Math.min(limit, MAX_PAGE_LIMIT)
  while (index >= 0 && index < entries.length && data.length < pageLimit) {
    const entry = project(entries[index]!)
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1
    // 单条可超软上限，以便完整保留条目。协议帧超过硬上限时由 host 返回超限错误。
    if (data.length && bytes + size > PAGE_BYTES) break
    data.push(entry)
    bytes += size
    index += step
  }
  return {
    data,
    nextCursor: data.length && index >= 0 && index < entries.length
      ? encodeCursor(scope, idFor(entries[index]!)) : null,
    backwardsCursor: data.length ? encodeCursor(scope, idFor(entries[first]!)) : null,
  }
}

export function listHistoryTurns(threadId: string, turns: readonly Json[], params: Json): Json {
  const view = params.itemsView ?? 'summary'
  if (view !== 'full' && view !== 'summary' && view !== 'notLoaded') {
    throw new BridgeRpcError(-32602, '历史轮次显示范围无效')
  }
  return page(turns, (turn) => scalarText(turn.id), (turn) => {
    if (view === 'full') return turn
    const items = view === 'summary' && Array.isArray(turn.items)
      ? turn.items.filter((item: unknown) => asRecord(item)?.type === 'userMessage' || asRecord(item)?.type === 'agentMessage')
      : []
    return { ...turn, items, itemsView: view }
  }, params, JSON.stringify(['turns', threadId]), 'desc')
}

export function listHistoryItems(threadId: string, turns: readonly Json[], params: Json): Json {
  const turnId = scalarText(params.turnId)
  const entries = turns.flatMap((turn) => {
    if ((turnId && turn.id !== turnId) || !Array.isArray(turn.items)) return []
    return turn.items.filter(isRecord).map((item) => ({ turnId: scalarText(turn.id), item, startedAtMs: null, completedAtMs: null }))
  })
  const scope = JSON.stringify(['items', threadId, turnId])
  const idFor = (entry: (typeof entries)[number]) => scalarText(entry.item.id)
  return page(entries, idFor, (entry) => entry, params, scope, 'asc', Boolean(turnId))
}

/** SDK/RPC 只提供整份历史。翻页复用最新快照，短时只保留一个会话。 */
export class HistoryPageCache {
  private entry: { threadId: string; read: Promise<Json[]>; loading: boolean; prefetched: boolean; expires: NodeJS.Timeout | null } | null = null

  /**
   * prefetch：由 thread/resume 预读（为取会话模型）。紧随其后的首页请求复用这份快照一次，
   * 避免同一次打开会话读两遍历史；之后的首页请求照常重读以拿到最新内容。
   */
  read(threadId: string, continuePage: boolean, load: () => Promise<Json[]>, prefetch = false): Promise<Json[]> {
    const previous = this.entry
    if (previous?.threadId === threadId && (continuePage || previous.loading || previous.prefetched)) {
      if (!prefetch) previous.prefetched = false
      return previous.read
    }
    this.clear()
    const read = load()
    const entry = { threadId, read, loading: true, prefetched: prefetch, expires: null as NodeJS.Timeout | null }
    this.entry = entry
    void read.then(() => {
      if (this.entry !== entry) return
      entry.loading = false
      entry.expires = setTimeout(() => this.clear(threadId), SNAPSHOT_MS)
      entry.expires.unref()
    }, () => {
      if (this.entry === entry) this.clear(threadId)
    })
    return read
  }

  clear(threadId?: string): void {
    if (!this.entry || (threadId !== undefined && this.entry.threadId !== threadId)) return
    if (this.entry.expires) clearTimeout(this.entry.expires)
    this.entry = null
  }
}
