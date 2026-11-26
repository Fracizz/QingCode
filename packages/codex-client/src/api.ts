import type {
  Model,
  ModelListResponse,
  SkillMetadata,
  SkillsListResponse,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  UserInput,
} from './codex-types'
import type { CodexRpc } from './rpc'

export type CodexRpcLike = Pick<CodexRpc, 'request'>

export function listThreads(
  rpc: CodexRpcLike,
  cwd?: string | null,
): Promise<ThreadListResponse> {
  return rpc.request('thread/list', cwd === undefined ? {} : { cwd })
}

export function startThread(
  rpc: CodexRpcLike,
  options: ThreadStartParams,
): Promise<ThreadStartResponse> {
  return rpc.request('thread/start', options)
}

export function resumeThread(
  rpc: CodexRpcLike,
  threadId: string,
): Promise<ThreadResumeResponse> {
  return rpc.request('thread/resume', { threadId })
}

export function readThread(
  rpc: CodexRpcLike,
  threadId: string,
): Promise<ThreadReadResponse> {
  return rpc.request('thread/read', { threadId, includeTurns: true })
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

/** 从会话完整历史分叉出一个新会话（Codex 的 thread/fork）。 */
export function forkThread(rpc: CodexRpcLike, threadId: string): Promise<ThreadForkResponse> {
  return rpc.request('thread/fork', { threadId })
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
