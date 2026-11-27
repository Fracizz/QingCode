import type { JsonRpcId } from '@qn/protocol'

export interface ForwardedRequest {
  clientId: number
  originalId: JsonRpcId
  daemonId: string
}

/**
 * 客户端请求 id 换成 daemon 侧 id 再转发，响应按原 id 回给发起者。
 * daemon 侧 id 用带前缀的字符串，避免和 codex 自己的数字 id 撞车。
 */
export class IdMapper {
  private next = 0
  private readonly byDaemonId = new Map<string, ForwardedRequest>()

  get size(): number {
    return this.byDaemonId.size
  }

  allocate(clientId: number, originalId: JsonRpcId): string {
    const daemonId = `qn-c${++this.next}`
    this.byDaemonId.set(daemonId, { clientId, originalId, daemonId })
    return daemonId
  }

  take(daemonId: unknown): ForwardedRequest | undefined {
    if (typeof daemonId !== 'string') return undefined
    const entry = this.byDaemonId.get(daemonId)
    if (entry) this.byDaemonId.delete(daemonId)
    return entry
  }

  dropClient(clientId: number): ForwardedRequest[] {
    const dropped: ForwardedRequest[] = []
    for (const [daemonId, entry] of this.byDaemonId) {
      if (entry.clientId !== clientId) continue
      dropped.push(entry)
      this.byDaemonId.delete(daemonId)
    }
    return dropped
  }

  clear(): ForwardedRequest[] {
    const dropped = [...this.byDaemonId.values()]
    this.byDaemonId.clear()
    return dropped
  }
}
