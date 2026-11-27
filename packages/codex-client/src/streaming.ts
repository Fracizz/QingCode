import type { ServerNotification } from './codex-types'

/** 流式增量合并写入 store 的间隔：约 20 帧/秒，文字仍连贯，渲染次数降一个数量级。 */
export const STREAM_FLUSH_MS = 50

/** 只有纯追加的流式增量（文本、命令输出等）可以延后合并；状态类通知会触发副作用，必须立即应用。 */
export function isStreamDelta(notification: Pick<ServerNotification, 'method'>): boolean {
  return /(?:\/delta|Delta)$/.test(notification.method)
}

/**
 * 按会话缓冲流式增量，定时合并成一次写入：逐条写入会让订阅会话的组件每个增量都重渲染，
 * 多会话并行时主线程被占满。调用方在应用其他通知或改写会话状态前先 flush(key)，保证写入顺序不变。
 */
export function createDeltaBuffer(
  apply: (key: string, notifications: ServerNotification[]) => void,
  delayMs = STREAM_FLUSH_MS,
) {
  const buffered = new Map<string, ServerNotification[]>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (key: string): void => {
    const list = buffered.get(key)
    if (!list) return
    buffered.delete(key)
    apply(key, list)
  }

  const flushAll = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const key of [...buffered.keys()]) flush(key)
  }

  return {
    push(key: string, notification: ServerNotification): void {
      const list = buffered.get(key)
      if (list) list.push(notification)
      else buffered.set(key, [notification])
      timer ??= setTimeout(flushAll, delayMs)
    },
    flush,
    flushAll,
    /** 丢弃某会话未写入的增量（会话被替换或断开时用）。 */
    drop(key: string): void {
      buffered.delete(key)
    },
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * 把流式中的 Markdown 按空行切成块，代码围栏内的空行不切。
 * 流式时每个增量只追加在末尾，前面的块文本不再变化，可以各自缓存解析结果，
 * 避免每个增量都重新解析整条消息（总开销随长度平方增长）。
 * 跨块的引用式链接等少数语法在流式期间可能暂时不生效，结束后应整条重新解析。
 */
export function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: { char: string; length: number } | null = null

  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)
    if (match) {
      const marker = match[1]!
      if (!fence) fence = { char: marker[0]!, length: marker.length }
      else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null
    }
    if (!fence && line.trim() === '' && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
      continue
    }
    if (current.length > 0 || line.trim() !== '' || fence) current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}
