/**
 * 手机锁屏后的排队代发。
 *
 * 手机 WebView 锁屏后会被系统冻结或断网，原先由手机自己发送的排队消息只能等用户回到界面。
 * 现在手机进入后台时把各会话的排队消息逐条交给电脑网关（put），由网关在当前一轮结束后接着发送；
 * 回到前台时一次性收回（take），网关只返回已发出的消息 ID 和暂停原因，手机据此修正本地队列。
 * 同一会话同一时刻只有一方负责发送，因此不会重复发出。
 */

export type RelayAgent = 'codex' | 'claude' | 'pi'
export type RelayAddress = { targetId: string; agent: RelayAgent; threadId: string }
/** 手机原本会发给网关的发送请求（mobile.turn.start 或 codex.send），msg.id 由网关生成。 */
export type RelayRequest = { method: 'mobile.turn.start' | 'codex.send'; params: Record<string, unknown> }
export type RelayItem = { id: string; request: RelayRequest }
export type RelayUpdate = RelayAddress & { sentIds: string[]; remaining: number; error?: string }
export type RelayTake = RelayAddress & { sentIds: string[]; error?: string }

// 与手机端持久化的暂停文案一致，手机用 translateMessage 翻译。
export const RELAY_TURN_FAILED = '上一轮未完成，队列已暂停'
export const RELAY_UNCONFIRMED = '上次发送结果未确认，请核对对话后再继续'
const RELAY_SEND_FAILED = '排队消息未发送'
/** 每条会话最多暂存的消息数，防止异常客户端无限堆积。 */
export const RELAY_MAX_ITEMS = 50
/** 收回前最多保留的已发送 ID，足够覆盖一次锁屏期间的发送量。 */
const MAX_SENT_IDS = 200

type Lane = {
  deviceId: string
  address: RelayAddress
  items: RelayItem[]
  sentIds: string[]
  running: boolean
  error?: string
  inflight: Promise<void> | null
  /** 发送回包前就已收到结束事件的轮次，回包到达时据此判断这一轮是否还在运行。 */
  finished: Map<string, string>
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type RelaySendError = { unconfirmed: boolean; message: string }

export type MobileQueueRelayOptions = {
  /** 发出一轮并返回 turn/start 的 JSON-RPC 回包；无法确认是否送达时抛出 { unconfirmed: true }。 */
  send: (request: RelayRequest) => Promise<unknown>
  /** 队列变化后通知对应手机；手机仍在线时可以立刻更新界面。 */
  notify: (deviceId: string, update: RelayUpdate) => void
}

function laneKey(deviceId: string, address: RelayAddress): string {
  return JSON.stringify([deviceId, address.targetId, address.agent, address.threadId])
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message
  if (error instanceof Error && error.message) return error.message
  return RELAY_SEND_FAILED
}

export class MobileQueueRelay {
  private readonly lanes = new Map<string, Lane>()

  constructor(private readonly options: MobileQueueRelayOptions) {}

  /** 追加一条待发消息。重复提交同一 ID 时忽略，便于手机在网络抖动后重试。 */
  put(deviceId: string, address: RelayAddress, item: RelayItem, running: boolean): void {
    const key = laneKey(deviceId, address)
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { deviceId, address, items: [], sentIds: [], running, inflight: null, finished: new Map() }
      this.lanes.set(key, lane)
    }
    if (lane.items.some((entry) => entry.id === item.id) || lane.sentIds.includes(item.id)) return
    if (lane.items.length >= RELAY_MAX_ITEMS) throw new Error('电脑暂存的排队消息过多')
    lane.items.push(item)
    this.pump(lane)
  }

  /** 收回该设备交给网关的全部队列；正在发送的那条先等结果，避免收回后两边各发一次。 */
  async take(deviceId: string): Promise<RelayTake[]> {
    const lanes = [...this.lanes.entries()].filter(([, lane]) => lane.deviceId === deviceId)
    for (const [key] of lanes) this.lanes.delete(key)
    const result: RelayTake[] = []
    for (const [, lane] of lanes) {
      // 先从表中移除再等待：等待期间到达的事件不再触发后续发送。
      lane.items = lane.items.slice(0, lane.inflight ? 1 : 0)
      await lane.inflight?.catch(() => undefined)
      result.push({ ...lane.address, sentIds: lane.sentIds, ...(lane.error ? { error: lane.error } : {}) })
    }
    return result
  }

  /** 目标机推来的通知：轮次开始、结束决定何时发送下一条。 */
  onNotification(targetId: string, agent: unknown, msg: unknown): void {
    if (!isRecord(msg) || !isRecord(msg.params)) return
    const method = msg.method
    if (method !== 'turn/started' && method !== 'turn/completed') return
    const threadId = msg.params.threadId
    if (typeof threadId !== 'string') return
    const turn = isRecord(msg.params.turn) ? msg.params.turn : {}
    for (const lane of this.lanes.values()) {
      const { address } = lane
      if (address.targetId !== targetId || address.threadId !== threadId || (agent !== undefined && address.agent !== agent)) continue
      if (method === 'turn/started') {
        lane.running = true
        continue
      }
      const status = typeof turn.status === 'string' ? turn.status : 'completed'
      if (lane.inflight && typeof turn.id === 'string') lane.finished.set(turn.id, status)
      lane.running = false
      // 上一轮失败或被中断时不自动续发，和手机端原有规则一致，等用户确认。
      if ((status === 'failed' || status === 'interrupted') && lane.items.length > 0 && !lane.inflight) {
        lane.error = RELAY_TURN_FAILED
        this.emit(lane)
      }
      this.pump(lane)
    }
  }

  /** 网关停止时丢弃全部暂存；手机收回时会把未确认的消息标为暂停。 */
  clear(): void {
    this.lanes.clear()
  }

  get size(): number {
    return this.lanes.size
  }

  private pump(lane: Lane): void {
    if (lane.inflight || lane.running || lane.error || lane.items.length === 0) return
    if (this.lanes.get(laneKey(lane.deviceId, lane.address)) !== lane) return
    const item = lane.items[0]!
    lane.finished.clear()
    lane.inflight = (async () => {
      // 先让出一拍，保证 inflight 已赋值再发送；同步到达的结束事件因此能记到 finished，而不会重入 pump。
      await Promise.resolve()
      try {
        const reply = await this.options.send(item.request)
        if (isRecord(reply) && isRecord(reply.error)) {
          lane.error = errorMessage(reply.error)
          return
        }
        const turn = isRecord(reply) && isRecord(reply.result) && isRecord(reply.result.turn) ? reply.result.turn : {}
        lane.items = lane.items.filter((entry) => entry.id !== item.id)
        lane.sentIds = [...lane.sentIds, item.id].slice(-MAX_SENT_IDS)
        const id = typeof turn.id === 'string' ? turn.id : ''
        const status = lane.finished.get(id) ?? (typeof turn.status === 'string' ? turn.status : 'inProgress')
        lane.running = status === 'inProgress'
        if ((status === 'failed' || status === 'interrupted') && lane.items.length > 0) lane.error = RELAY_TURN_FAILED
      } catch (error) {
        lane.error = isRecord(error) && error.unconfirmed === true ? RELAY_UNCONFIRMED : errorMessage(error)
      } finally {
        lane.inflight = null
        lane.finished.clear()
        this.emit(lane)
        this.pump(lane)
      }
    })()
  }

  private emit(lane: Lane): void {
    try {
      this.options.notify(lane.deviceId, {
        ...lane.address,
        sentIds: lane.sentIds,
        remaining: lane.items.length,
        ...(lane.error ? { error: lane.error } : {}),
      })
    } catch {
      // 通知只用于实时刷新，失败时手机收回队列仍能拿到结果。
    }
  }
}

/** 校验手机提交的 put 参数；只接受发送一轮所需的字段，其余一律拒绝。 */
export function parseRelayPut(params: unknown): { address: RelayAddress; item: RelayItem; running: boolean } | null {
  if (!isRecord(params)) return null
  const { targetId, agent, threadId, id, running, request } = params
  if (typeof targetId !== 'string' || !targetId || typeof threadId !== 'string' || !threadId) return null
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'pi') return null
  if (typeof id !== 'string' || !id || id.length > 128 || typeof running !== 'boolean' || !isRecord(request)) return null
  if (request.method !== 'mobile.turn.start' && request.method !== 'codex.send') return null
  const body = request.params
  if (!isRecord(body) || body.targetId !== targetId || body.agent !== agent) return null
  const msg = body.msg
  if (!isRecord(msg) || msg.method !== 'turn/start' || !isRecord(msg.params) || msg.params.threadId !== threadId) return null
  return { address: { targetId, agent, threadId }, item: { id, request: { method: request.method, params: body } }, running }
}
