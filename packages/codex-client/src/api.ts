import type {
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

export function sendText(
  rpc: CodexRpcLike,
  threadId: string,
  text: string,
): Promise<TurnStartResponse> {
  const input: UserInput[] = [{ type: 'text', text, text_elements: [] }]
  return rpc.request('turn/start', { threadId, input })
}

export function interruptTurn(
  rpc: CodexRpcLike,
  threadId: string,
  turnId: string,
): Promise<TurnInterruptResponse> {
  return rpc.request('turn/interrupt', { threadId, turnId })
}
