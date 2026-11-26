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
  Turn,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from './codex-types'
import { CodexRpcError, type CodexRpc } from './rpc'
import { emptyState, loadThread } from './conversation'

export type CodexRpcLike = Pick<CodexRpc, 'request'>

export async function listThreads(
  rpc: CodexRpcLike,
  cwd?: string | string[] | null,
  limit?: number,
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

async function withHistory<T extends { thread: Thread }>(
  rpc: CodexRpcLike,
  threadId: string,
  request: (metadataOnly: boolean) => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T> {
  const checkCurrent = () => {
    if (isCurrent && !isCurrent()) throw new Error('已取消打开会话')
  }
  try {
    return await request(false)
  } catch (error) {
    if (!isOversizeHistoryResponse(error)) throw error
    checkCurrent()
    const result = await request(true)
    if (result.thread?.id !== threadId) throw new Error('返回的会话与所选会话不一致，请重试')
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
      if (seenCursors.has(cursor)) throw new Error('会话历史分页未前进，请重试')
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

export async function readSubagentThread(rpc: CodexRpcLike, threadId: string) {
  const { thread } = await readThread(rpc, threadId)
  if (thread?.id !== threadId) throw new Error('返回的子代理会话与请求不一致')
  return {
    name: thread.agentNickname || thread.name || thread.agentRole,
    view: loadThread(emptyState(), thread).threads[threadId],
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
): Promise<TurnStartResponse> {
  const extra: TurnOverrides = {}
  if (overrides.model) extra.model = overrides.model
  if (overrides.effort) extra.effort = overrides.effort
  if (overrides.serviceTier !== undefined) extra.serviceTier = overrides.serviceTier
  return rpc.request('turn/start', { threadId, input, ...extra })
}

export function steerTurn(
  rpc: CodexRpcLike,
  threadId: string,
  expectedTurnId: string,
  input: UserInput[],
): Promise<TurnSteerResponse> {
  return rpc.request('turn/steer', { threadId, expectedTurnId, input })
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
