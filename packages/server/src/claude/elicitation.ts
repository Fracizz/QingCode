/** Claude SDK onElicitation ↔ v2 mcpServer/elicitation/request（纯逻辑），客户端与 Codex 共用一套界面。 */
import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk'
import { asRecord, type Json } from './v2'

export const ELICITATION_METHOD = 'mcpServer/elicitation/request'

export function buildElicitationRequest(
  requestId: string,
  threadId: string,
  turnId: string | null,
  request: ElicitationRequest,
): { id: string; method: string; params: Json } {
  const base = {
    threadId,
    turnId,
    serverName: request.serverName,
    environmentId: null,
    _meta: null,
    message: request.message,
  }
  return {
    id: requestId,
    method: ELICITATION_METHOD,
    params: request.mode === 'url'
      ? { ...base, mode: 'url', url: request.url ?? '', elicitationId: request.elicitationId ?? '' }
      : { ...base, mode: 'form', requestedSchema: request.requestedSchema ?? { type: 'object', properties: {} } },
  }
}

/** 客户端响应 → SDK 结果；出错或形状不对按取消处理。 */
export function elicitationResult(response: unknown): ElicitationResult {
  const result = asRecord(asRecord(response)?.result)
  const action = result?.action
  if (action === 'decline') return { action }
  if (action !== 'accept') return { action: 'cancel' }
  const content = asRecord(result?.content)
  return { action, ...(content ? { content: content as ElicitationResult['content'] } : {}) }
}
