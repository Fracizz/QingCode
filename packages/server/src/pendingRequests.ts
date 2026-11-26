import type { JsonRpcId } from '@qn/protocol'

export interface PendingRequest {
  id: JsonRpcId
  seq: number
  msg: Record<string, unknown>
}

/**
 * codex 的 server→client 请求（审批等）广播给所有客户端，只有第一个响应算数。
 * 数字 1 与字符串 '1' 是不同 id，键里带类型避免互相覆盖。
 */
export class PendingRequests {
  private readonly map = new Map<string, PendingRequest>()

  get size(): number {
    return this.map.size
  }

  add(id: JsonRpcId, msg: Record<string, unknown>, seq: number): void {
    const key = idKey(id)
    if (!this.map.has(key)) this.map.set(key, { id, msg, seq })
  }

  /** 取走并删除；返回 undefined 表示重复响应已被忽略。 */
  resolve(id: JsonRpcId): PendingRequest | undefined {
    const key = idKey(id)
    const found = this.map.get(key)
    if (found) this.map.delete(key)
    return found
  }

  /** codex 自行发出 serverRequest/resolved 时清掉未决卡片。 */
  drop(id: JsonRpcId): boolean {
    return this.map.delete(idKey(id))
  }

  snapshot(): PendingRequest[] {
    return [...this.map.values()]
  }

  clear(): void {
    this.map.clear()
  }
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}
