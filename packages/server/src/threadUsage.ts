const MAX_THREADS = 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 记住每个会话最近一次上报的用量，并附到打开会话的响应里。
 * 用量只在轮次进行中推送，打开历史会话（尤其是另一端跑过的、或以只读方式打开的）时客户端没有读数，
 * 占用环和「会话用量」会一直是空的，直到下一轮开始。
 */
export class ThreadUsage {
  private readonly usage = new Map<string, unknown>()

  notification(message: Record<string, unknown>): void {
    if (message.method !== 'thread/tokenUsage/updated') return
    const params = message.params
    if (!isRecord(params) || typeof params.threadId !== 'string' || !params.threadId || !isRecord(params.tokenUsage)) return
    // 重新插入让最近活跃的会话排到末尾，超量时淘汰最久未更新的。
    this.usage.delete(params.threadId)
    this.usage.set(params.threadId, params.tokenUsage)
    if (this.usage.size > MAX_THREADS) this.usage.delete(this.usage.keys().next().value!)
  }

  /** thread/start、resume、read、fork 的响应都带 result.thread；已自带用量的不覆盖。 */
  history(result: unknown): unknown {
    if (!this.usage.size || !isRecord(result) || !isRecord(result.thread)) return result
    const thread = result.thread
    if (typeof thread.id !== 'string' || thread.tokenUsage !== undefined) return result
    const tokenUsage = this.usage.get(thread.id)
    return tokenUsage === undefined ? result : { ...result, thread: { ...thread, tokenUsage } }
  }

  clear(): void {
    this.usage.clear()
  }
}
