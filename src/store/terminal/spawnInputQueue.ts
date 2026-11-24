/**
 * PTY 新建/接回在途期间的键盘输入暂存。
 *
 * 远端服务更新、隧道重建时新建或接回可能要等数秒，此时后端还没有该终端，
 * 直接下发会报「SSH 终端不存在」。先按顺序暂存，成功后一次补发；失败或关闭则丢弃。
 */

/** 与后端单次输入上限（1MB）对齐，超出部分丢弃。 */
export const SPAWN_INPUT_QUEUE_LIMIT = 1024 * 1024

const queues = new Map<string, string[]>()
const sizes = new Map<string, number>()

/** 暂存一段输入；超出上限时不收并返回 false。 */
export function queueSpawnInput(id: string, data: string): boolean {
  if (!data) return true
  const used = sizes.get(id) ?? 0
  if (used + data.length > SPAWN_INPUT_QUEUE_LIMIT) return false
  const queue = queues.get(id)
  if (queue) queue.push(data)
  else queues.set(id, [data])
  sizes.set(id, used + data.length)
  return true
}

/** 取出并清空暂存的输入，按输入顺序拼接；没有则返回空串。 */
export function takeSpawnInput(id: string): string {
  const queue = queues.get(id)
  discardSpawnInput(id)
  return queue ? queue.join('') : ''
}

export function discardSpawnInput(id: string): void {
  queues.delete(id)
  sizes.delete(id)
}
