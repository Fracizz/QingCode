import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { agentConfigEnv } from '../codexHost'
import { redact } from '../log'

type SessionListOptions = { dir?: string; limit?: number; includeWorktrees?: boolean }
type MessageListOptions = { dir?: string }
type SessionRequest =
  | { method: 'list'; options?: SessionListOptions }
  | { method: 'info'; sessionId: string }
  | { method: 'messages'; sessionId: string; options?: MessageListOptions }

export interface ClaudeSessionReader {
  listSessions(options?: SessionListOptions): Promise<unknown[]>
  getSessionInfo?(sessionId: string): Promise<unknown>
  getSessionMessages(sessionId: string, options?: MessageListOptions): Promise<unknown[]>
}

type Reply = { result: unknown } | { error: string }

// SDK 的独立历史接口读取调用方环境。复用 daemon 入口启动一次性 worker，避免改动共享环境或解析历史文件。
export function isolatedClaudeSessionReader(directory: string): ClaudeSessionReader {
  function read<T>(request: SessionRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { qnClaudeHistory: request },
        env: agentConfigEnv(process.env, 'CLAUDE_CONFIG_DIR', directory),
      })
      worker.once('message', (reply: Reply) => {
        if ('error' in reply) reject(new Error(reply.error))
        else resolve(reply.result as T)
      })
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('Claude 历史读取 worker 未返回结果')))
      worker.unref()
    })
  }
  return {
    listSessions: (options) => read({ method: 'list', options }),
    getSessionInfo: (sessionId) => read({ method: 'info', sessionId }),
    getSessionMessages: (sessionId, options) => read({ method: 'messages', sessionId, options }),
  }
}

export async function runClaudeHistoryWorker(): Promise<boolean> {
  const request: SessionRequest | undefined = isMainThread ? undefined : workerData?.qnClaudeHistory
  if (!request || !parentPort) return false
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    let result: unknown
    switch (request.method) {
      case 'list':
        result = await sdk.listSessions(request.options)
        break
      case 'info':
        result = await sdk.getSessionInfo(request.sessionId)
        break
      case 'messages':
        result = await sdk.getSessionMessages(request.sessionId, request.options)
        break
    }
    parentPort.postMessage({ result } satisfies Reply)
  } catch (error) {
    parentPort.postMessage({ error: redact(error instanceof Error ? error.message : String(error)) } satisfies Reply)
  }
  return true
}
