import { t } from '../../protocol/src/i18n'
import type {
  Model,
  ModelListResponse,
  SkillMetadata,
  SkillsListResponse,
  Thread,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadItemsListResponse,
  ThreadTurnsListResponse,
  Turn,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from './codex-types'
import { CodexRpcError, type CodexRpc } from './rpc'
import { emptyState, loadRecentThreadHistory } from './conversation'

export type CodexRpcLike = Pick<CodexRpc, 'request'>

export async function listThreads(
  rpc: CodexRpcLike,
  cwd?: string | string[] | null,
  limit?: number,
  options?: { archived?: boolean },
): Promise<ThreadListResponse> {
  if (limit !== undefined && limit <= 0) return { data: [], nextCursor: null, backwardsCursor: null }
  const threads = new Map<string, Thread>()
  const seenCursors = new Set<string>()
  let nextCursor: string | null = null
  let backwardsCursor: string | null = null
  do {
    const page: ThreadListResponse = await rpc.request('thread/list', {
      ...(cwd === undefined ? {} : { cwd }),
      ...(limit === undefined ? {} : { limit: limit - threads.size }),
      ...(options?.archived === undefined ? {} : { archived: options.archived }),
      ...(nextCursor ? { cursor: nextCursor } : {}),
      sortKey: 'updated_at',
    })
    if (!nextCursor) backwardsCursor = page?.backwardsCursor ?? null
    for (const thread of Array.isArray(page?.data) ? page.data : []) {
      if (thread?.id && !threads.has(thread.id)) threads.set(thread.id, thread)
      if (limit !== undefined && threads.size >= limit) break
    }
    nextCursor = page?.nextCursor ?? null
    if (!nextCursor || seenCursors.has(nextCursor) || (limit !== undefined && threads.size >= limit)) break
    seenCursors.add(nextCursor)
  } while (nextCursor)
  return { data: [...threads.values()], nextCursor, backwardsCursor }
}

export function startThread(
  rpc: CodexRpcLike,
  options: ThreadStartParams,
): Promise<ThreadStartResponse> {
  return rpc.request('thread/start', options)
}

export function isOversizeHistoryResponse(error: unknown): boolean {
  return error instanceof CodexRpcError && error.data === 'response_too_large'
}

/** 先监听再请求，避免快于 RPC 回执的通知丢失。 */
export async function startThreadCompaction(rpc: CodexRpc, threadId: string): Promise<void> {
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = new Promise<boolean>((resolve) => {
    unsubscribe = rpc.onNotification((note) => {
      if ((note.method === 'turn/started' || note.method === 'turn/completed' ||
        (note.method === 'item/started' && note.params.item.type === 'contextCompaction')) &&
        note.params.threadId === threadId) resolve(true)
    })
    timer = setTimeout(() => resolve(false), 30_000)
  })
  try {
    await rpc.request('thread/compact/start', { threadId })
    if (!(await started)) throw new Error(t('尚未收到压缩进度，请检查当前会话'))
  } finally {
    unsubscribe()
    clearTimeout(timer)
  }
}

async function withHistory<T extends { thread: Thread }>(
  rpc: CodexRpcLike,
  threadId: string,
  request: (metadataOnly: boolean) => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T> {
  const checkCurrent = () => {
    if (isCurrent && !isCurrent()) throw new Error(t('已取消打开会话'))
  }
  try {
    return await request(false)
  } catch (error) {
    if (!isOversizeHistoryResponse(error)) throw error
    checkCurrent()
    const result = await request(true)
    if (result.thread?.id !== threadId) throw new Error(t('返回的会话与所选会话不一致，请重试'))
    if (result.thread.turns?.length) return result

    // 单页超限时缩小页长，保留命令输出、文件改动和其他完整条目。
    const turns = new Map<string, Turn>()
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    let limit = 20
    for (;;) {
      checkCurrent()
      if (cursor) seenCursors.add(cursor)
      let page
      try {
        page = await rpc.request('thread/turns/list', {
          // 最后读取正在变化的最新轮次，缩短历史与实时事件重叠的时间。
          threadId, cursor, limit, sortDirection: 'asc', itemsView: 'full',
        })
      } catch (pageError) {
        if (pageError instanceof CodexRpcError && pageError.code === -32601) throw error
        if (!isOversizeHistoryResponse(pageError) || limit === 1) throw pageError
        limit = Math.max(1, Math.floor(limit / 2))
        continue
      }
      for (const turn of page.data) {
        if (!turns.has(turn.id)) turns.set(turn.id, turn)
      }
      cursor = page.nextCursor
      if (!cursor) break
      if (seenCursors.has(cursor)) throw new Error(t('会话历史分页未前进，请重试'))
    }
    checkCurrent()
    const history = [...turns.values()]
    let status = result.thread.status
    if (status?.type === 'active' && history.at(-1)?.status !== 'inProgress') {
      const latest = await rpc.request('thread/read', { threadId, includeTurns: false })
      if (latest.thread?.id === threadId) status = latest.thread.status
    }
    return { ...result, thread: { ...result.thread, turns: history, status } }
  }
}

export function resumeThread(
  rpc: CodexRpcLike,
  threadId: string,
  isCurrent?: () => boolean,
): Promise<ThreadResumeResponse> {
  return withHistory(rpc, threadId, (metadataOnly) => rpc.request(
    'thread/resume', metadataOnly ? { threadId, excludeTurns: true } : { threadId },
  ), isCurrent)
}

export function readThread(
  rpc: CodexRpcLike,
  threadId: string,
  isCurrent?: () => boolean,
): Promise<ThreadReadResponse> {
  return withHistory(rpc, threadId, (metadataOnly) => rpc.request(
    'thread/read', { threadId, includeTurns: !metadataOnly },
  ), isCurrent)
}

export type ThreadHistoryCursor =
  | { turns: string }
  | { turn: Turn; items: string; nextTurn: string | null }

export type ThreadHistoryPage = { turns: Turn[]; earlier: ThreadHistoryCursor | null }

function assertHistoryCurrent(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) throw new Error(t('已取消加载会话历史'))
}

async function fitHistoryPage<T>(limit: number, request: (limit: number) => Promise<T>, isCurrent?: () => boolean): Promise<T> {
  for (;;) {
    assertHistoryCurrent(isCurrent)
    try {
      const page = await request(limit)
      assertHistoryCurrent(isCurrent)
      return page
    } catch (error) {
      if (!isOversizeHistoryResponse(error) || limit === 1) throw error
      limit = Math.floor(limit / 2)
    }
  }
}

async function readTurnItemsPage(
  rpc: CodexRpcLike,
  threadId: string,
  turn: Turn,
  cursor: string | null,
  nextTurn: string | null,
  isCurrent?: () => boolean,
): Promise<ThreadHistoryPage> {
  const page = await fitHistoryPage<ThreadItemsListResponse>(24, (limit) => rpc.request('thread/items/list', {
    threadId, turnId: turn.id, cursor, limit, sortDirection: 'desc',
  }), isCurrent)
  if (page.nextCursor && page.nextCursor === cursor) throw new Error(t('会话条目分页未前进，请重试'))
  return {
    turns: [{ ...turn, itemsView: 'full', items: page.data.map(({ item, completedAtMs }) =>
      item.completedAtMs == null && completedAtMs != null ? { ...item, completedAtMs } : item,
    ).reverse() }],
    earlier: page.nextCursor ? { turn, items: page.nextCursor, nextTurn } : nextTurn ? { turns: nextTurn } : null,
  }
}

export async function readThreadHistoryPage(
  rpc: CodexRpcLike,
  threadId: string,
  earlier: ThreadHistoryCursor | null,
  isCurrent?: () => boolean,
): Promise<ThreadHistoryPage> {
  if (earlier && 'items' in earlier) {
    return readTurnItemsPage(rpc, threadId, earlier.turn, earlier.items, earlier.nextTurn, isCurrent)
  }
  const cursor = earlier?.turns ?? null
  let page: ThreadTurnsListResponse
  try {
    page = await fitHistoryPage(8, (limit) => rpc.request('thread/turns/list', {
      threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full',
    }), isCurrent)
  } catch (error) {
    if (!isOversizeHistoryResponse(error)) throw error
    // 超长轮次按条目向前读取，避免丢掉轮内的命令、改动或早期消息。
    assertHistoryCurrent(isCurrent)
    page = await rpc.request('thread/turns/list', { threadId, cursor, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
    assertHistoryCurrent(isCurrent)
    if (page.nextCursor && page.nextCursor === cursor) throw new Error(t('会话历史分页未前进，请重试'))
    const turn = page.data[0]
    if (!turn) throw error
    try {
      return await readTurnItemsPage(rpc, threadId, { ...turn, items: [] }, null, page.nextCursor, isCurrent)
    } catch (itemError) {
      if (itemError instanceof CodexRpcError && itemError.code === -32601) throw error
      throw itemError
    }
  }
  if (page.nextCursor && page.nextCursor === cursor) throw new Error(t('会话历史分页未前进，请重试'))
  return { turns: [...page.data].reverse(), earlier: page.nextCursor ? { turns: page.nextCursor } : null }
}

export async function openThreadHistory(
  rpc: CodexRpcLike,
  threadId: string,
  mode: 'resume' | 'read',
  isCurrent?: () => boolean,
): Promise<{ thread: Thread; earlier: ThreadHistoryCursor | null }> {
  assertHistoryCurrent(isCurrent)
  const result = mode === 'resume'
    ? await rpc.request('thread/resume', { threadId, excludeTurns: true })
    : await rpc.request('thread/read', { threadId, includeTurns: false })
  assertHistoryCurrent(isCurrent)
  const thread = result?.thread
  if (thread?.id !== threadId) throw new Error(t('返回的会话与所选会话不一致，请重试'))
  if (thread.turns?.length) return { thread, earlier: null }
  const cursor = 'turnsBackwardsCursor' in result && typeof result.turnsBackwardsCursor === 'string'
    ? { turns: result.turnsBackwardsCursor } : null
  try {
    const page = await readThreadHistoryPage(rpc, threadId, cursor, isCurrent)
    let status = thread.status
    if (status?.type === 'active' && !page.turns.some((turn) => turn.status === 'inProgress')) {
      const latest = await rpc.request('thread/read', { threadId, includeTurns: false })
      assertHistoryCurrent(isCurrent)
      if (latest.thread?.id === threadId) status = latest.thread.status
    }
    return { thread: { ...thread, turns: page.turns, status }, earlier: page.earlier }
  } catch (error) {
    // 老版本没有历史分页时，恢复已完成，仍可通过原本的读历史接口获取内容。
    if (!(error instanceof CodexRpcError) || error.code !== -32601) throw error
    assertHistoryCurrent(isCurrent)
    const legacy = await readThread(rpc, threadId, isCurrent)
    assertHistoryCurrent(isCurrent)
    if (legacy.thread?.id !== threadId) throw new Error(t('返回的会话与所选会话不一致，请重试'))
    return { thread: legacy.thread, earlier: null }
  }
}

export async function readSubagentThread(rpc: CodexRpcLike, threadId: string, isCurrent?: () => boolean) {
  const { thread, earlier } = await openThreadHistory(rpc, threadId, 'read', isCurrent)
  return {
    name: thread.agentNickname || thread.name || thread.agentRole,
    role: thread.agentRole,
    model: thread.model,
    task: thread.preview,
    view: loadRecentThreadHistory(emptyState(), thread, earlier, undefined).threads[threadId],
  }
}

export function setThreadName(rpc: CodexRpcLike, threadId: string, name: string): Promise<unknown> {
  return rpc.request('thread/name/set', { threadId, name })
}

export function archiveThread(rpc: CodexRpcLike, threadId: string): Promise<unknown> {
  return rpc.request('thread/archive', { threadId })
}

export function deleteThread(rpc: CodexRpcLike, threadId: string): Promise<unknown> {
  return rpc.request('thread/delete', { threadId })
}

/** 从会话历史分叉出一个新会话（Codex 的 thread/fork）；给出 lastTurnId 时只保留到该轮（含）。 */
export function forkThread(rpc: CodexRpcLike, threadId: string, lastTurnId?: string): Promise<ThreadForkResponse> {
  return rpc.request('thread/fork', lastTurnId ? { threadId, lastTurnId } : { threadId })
}

/** turn/start 的覆盖项：对本次及之后的 turn 生效；未设置的字段不发送，沿用会话当前配置。 */
export type TurnOverrides = {
  model?: string | null
  effort?: string | null
  serviceTier?: string | null
}

export function sendText(
  rpc: CodexRpcLike,
  threadId: string,
  text: string,
  overrides: TurnOverrides = {},
): Promise<TurnStartResponse> {
  return sendInput(rpc, threadId, [{ type: 'text', text, text_elements: [] }], overrides)
}

/** 发送任意组合的用户输入（文本、图片、附件文件、技能）。 */
export function sendInput(
  rpc: CodexRpcLike,
  threadId: string,
  input: UserInput[],
  overrides: TurnOverrides = {},
  clientUserMessageId?: string,
): Promise<TurnStartResponse> {
  const extra: TurnOverrides = {}
  if (overrides.model) extra.model = overrides.model
  if (overrides.effort) extra.effort = overrides.effort
  if (overrides.serviceTier !== undefined) extra.serviceTier = overrides.serviceTier
  return rpc.request('turn/start', { threadId, input, ...extra, ...(clientUserMessageId ? { clientUserMessageId } : {}) })
}

export function steerTurn(
  rpc: CodexRpcLike,
  threadId: string,
  expectedTurnId: string,
  input: UserInput[],
  clientUserMessageId?: string,
): Promise<TurnSteerResponse> {
  return rpc.request('turn/steer', { threadId, expectedTurnId, input, ...(clientUserMessageId ? { clientUserMessageId } : {}) })
}

/** 拉取全部可见模型（自动翻页，最多 10 页防止服务端游标异常导致死循环）。 */
export async function listModels(rpc: CodexRpcLike): Promise<Model[]> {
  const models: Model[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page++) {
    const result: ModelListResponse = await rpc.request('model/list', cursor ? { cursor } : {})
    models.push(...(Array.isArray(result?.data) ? result.data : []))
    cursor = result?.nextCursor ?? null
    if (!cursor) break
  }
  return models
}

export function interruptTurn(
  rpc: CodexRpcLike,
  threadId: string,
  turnId: string,
): Promise<TurnInterruptResponse> {
  return rpc.request('turn/interrupt', { threadId, turnId })
}

/** 列出 cwd 下可用的技能（用户级 + 项目级）；服务端不支持时由调用方兜底为空。 */
export async function listSkills(rpc: CodexRpcLike, cwd?: string | null): Promise<SkillMetadata[]> {
  const result: SkillsListResponse = await rpc.request('skills/list', cwd ? { cwds: [cwd] } : {})
  const seen = new Set<string>()
  const skills: SkillMetadata[] = []
  for (const entry of Array.isArray(result?.data) ? result.data : []) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      if (!skill?.name || skill.enabled === false || seen.has(skill.name)) continue
      seen.add(skill.name)
      skills.push(skill)
    }
  }
  return skills
}
