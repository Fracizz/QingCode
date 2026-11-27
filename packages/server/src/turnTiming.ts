const MAX_COMPLETED_TURNS = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function durationFromTimestamps(turn: Record<string, unknown>): number | undefined {
  const { startedAt, completedAt } = turn
  if (typeof startedAt !== 'number' || startedAt <= 0 || typeof completedAt !== 'number') return
  const duration = (completedAt - startedAt) * 1000
  return validDuration(duration) ? duration : undefined
}

export class TurnTiming {
  private readonly started = new Map<string, number>()
  private readonly completed = new Map<string, number>()

  notification(message: Record<string, unknown>): Record<string, unknown> {
    const { method, params } = message
    if (method !== 'turn/started' && method !== 'turn/completed') return message
    if (!isRecord(params) || typeof params.threadId !== 'string' || !isRecord(params.turn) || typeof params.turn.id !== 'string') return message
    const turn = params.turn
    const key = JSON.stringify([params.threadId, turn.id])
    if (method === 'turn/started') {
      if (!this.started.has(key) && !this.completed.has(key)) this.started.set(key, performance.now())
      return message
    }

    const start = this.started.get(key)
    this.started.delete(key)
    // 中继计时使用目标机的单调时钟，避免各客户端的时钟、网络和回放速度影响用时。
    const duration = validDuration(turn.durationMs) ? turn.durationMs
      : this.completed.get(key) ?? durationFromTimestamps(turn) ?? (start === undefined ? undefined : Math.round(performance.now() - start))
    if (duration === undefined) return message
    this.completed.set(key, duration)
    if (this.completed.size > MAX_COMPLETED_TURNS) this.completed.delete(this.completed.keys().next().value!)
    return duration === turn.durationMs ? message : { ...message, params: { ...params, turn: { ...turn, durationMs: duration } } }
  }

  history(result: unknown, pageThreadId?: string): unknown {
    if (!this.completed.size || !isRecord(result)) return result
    const fill = (turns: unknown[], threadId: string) => turns.map((turn: unknown) => {
      if (!isRecord(turn) || typeof turn.id !== 'string' || turn.status === 'inProgress' || validDuration(turn.durationMs)) return turn
      const durationMs = this.completed.get(JSON.stringify([threadId, turn.id]))
      return durationMs === undefined ? turn : { ...turn, durationMs }
    })
    if (pageThreadId && Array.isArray(result.data)) return { ...result, data: fill(result.data, pageThreadId) }
    const thread = result.thread
    if (!isRecord(thread) || typeof thread.id !== 'string' || !Array.isArray(thread.turns) || !thread.turns.length) return result
    return { ...result, thread: { ...thread, turns: fill(thread.turns, thread.id) } }
  }

  clearRunning(): void {
    this.started.clear()
  }

  clear(): void {
    this.clearRunning()
    this.completed.clear()
  }
}
