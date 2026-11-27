import { CodexRpcError, isOversizeHistoryResponse, openThreadHistory, type ClientRequestMap, type CodexRpcLike } from '@qn/codex-client'
import { isJsonRpcResponse } from '@qn/protocol'
import { RouterError, type CodexReplyRoute } from '../router'

const MAX_HISTORY_BYTES = 7 * 1024 * 1024 // 给 Android 的 8 MiB HTTP 响应上限留出余量。

export type MobileHistoryAddress = { targetId: string; agent: 'codex' | 'claude' | 'pi'; threadId: string }

type SendHistoryRequest = (
  params: { targetId: string; agent: MobileHistoryAddress['agent']; msg: unknown }, route: CodexReplyRoute,
) => Promise<unknown>

export async function openMobileHistory(address: MobileHistoryAddress, send: SendHistoryRequest, signal: AbortSignal) {
  const { targetId, agent, threadId } = address
  const current = () => !signal.aborted
  const rpc: CodexRpcLike = {
    request: async <M extends keyof ClientRequestMap>(method: M, params: ClientRequestMap[M]['params']) => {
      signal.throwIfAborted()
      const response = await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        const finish = (action: () => void) => {
          signal.removeEventListener('abort', abort)
          action()
        }
        // router 给每条请求分配唯一 ID，单独消费回复，Agent 的实时事件仍走原事件流。
        void send({ targetId, agent, msg: { id: 'history', method, params } }, {
          signal,
          receive: ({ msg }) => finish(() => resolve(msg)),
        }).catch((err: unknown) => finish(() => reject(err)))
      })
      if (!isJsonRpcResponse(response)) throw new RouterError('invalid_response', '目标返回了无效的会话历史')
      if ('error' in response) throw new CodexRpcError(response.error.message, response.error.code, response.error.data)
      if ((method === 'thread/turns/list' || method === 'thread/items/list') &&
          Buffer.byteLength(JSON.stringify(response.result)) > MAX_HISTORY_BYTES) {
        throw new CodexRpcError('会话历史页超过手机响应上限', -32000, 'response_too_large')
      }
      return response.result as ClientRequestMap[M]['result']
    },
  }
  let result: Awaited<ReturnType<typeof openThreadHistory>>
  let resumed = true
  try {
    try {
      result = await openThreadHistory(rpc, threadId, 'resume', current)
    } catch (err) {
      if (agent !== 'codex' || signal.aborted || isOversizeHistoryResponse(err) ||
          (err instanceof RouterError && err.code === 'not_connected')) throw err
      result = await openThreadHistory(rpc, threadId, 'read', current)
      resumed = false
    }
  } catch (err) {
    if (isOversizeHistoryResponse(err)) throw new RouterError('response_too_large', '会话历史超过手机响应上限')
    if (signal.aborted) throw new RouterError('timeout', '打开会话已取消或超时')
    throw err
  }
  const history = { ...result, resumed }
  if (Buffer.byteLength(JSON.stringify(history)) > MAX_HISTORY_BYTES) {
    throw new RouterError('response_too_large', '会话历史超过手机响应上限')
  }
  return history
}
