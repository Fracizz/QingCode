import { safeInvoke } from '@/lib/tauri'

/**
 * 手机接入电脑终端时的输出转发。转发只在手机使用期间进行，电脑自己的显示链路不变。
 * 输出在进入渲染批处理之前接出：窗口最小化时 requestAnimationFrame 可能暂停，手机不能跟着停。
 */

export interface TerminalCapture {
  data: string
  cols: number
  rows: number
}

type MirrorItem =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'screen'; data: string; cols: number; rows: number }
  | { kind: 'finish'; exitCode: number; disconnected: boolean }

interface Mirror {
  queue: MirrorItem[]
  open: boolean
  pumping: boolean
}

/** 单次发送上限，与手机轮询分页同量级。 */
const MAX_FORWARD_BYTES = 64 * 1024

const captures = new Map<string, () => Promise<TerminalCapture>>()
const mirrors = new Map<string, Mirror>()

export function registerTerminalCapture(id: string, capture: () => Promise<TerminalCapture>) {
  captures.set(id, capture)
  return () => {
    if (captures.get(id) === capture) captures.delete(id)
  }
}

export function terminalCapture(id: string) {
  return captures.get(id)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // 分段转换：String.fromCharCode 一次传太多参数会栈溢出。
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** 取出下一项发送内容，相邻输出合并成一次调用。 */
export function takeMirrorBatch(queue: MirrorItem[]): MirrorItem | undefined {
  const first = queue.shift()
  if (first?.kind !== 'bytes') return first
  const parts = [first.bytes]
  let size = first.bytes.length
  while (queue[0]?.kind === 'bytes' && size + queue[0].bytes.length <= MAX_FORWARD_BYTES) {
    const next = queue.shift() as Extract<MirrorItem, { kind: 'bytes' }>
    parts.push(next.bytes)
    size += next.bytes.length
  }
  if (parts.length === 1) return first
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return { kind: 'bytes', bytes }
}

function send(id: string, item: MirrorItem): Promise<void> {
  if (item.kind === 'bytes') {
    return safeInvoke('转发终端输出', 'mobile_mirror_output', { id, data: bytesToBase64(item.bytes) })
  }
  if (item.kind === 'screen') {
    return safeInvoke('转发终端画面', 'mobile_mirror_screen', {
      id, data: item.data, cols: item.cols, rows: item.rows,
    })
  }
  return safeInvoke('结束终端转发', 'mobile_mirror_finish', {
    id, exitCode: item.exitCode, disconnected: item.disconnected,
  })
}

async function pump(id: string, mirror: Mirror) {
  if (mirror.pumping || !mirror.open) return
  mirror.pumping = true
  try {
    while (mirrors.get(id) === mirror && mirror.queue.length) {
      const item = takeMirrorBatch(mirror.queue)
      if (!item) break
      if (item.kind === 'finish') mirrors.delete(id)
      await send(id, item).catch(error => console.warn('Terminal mirror send failed', error))
    }
  } finally {
    mirror.pumping = false
  }
}

function enqueue(id: string, item: MirrorItem) {
  const mirror = mirrors.get(id)
  if (!mirror) return
  mirror.queue.push(item)
  void pump(id, mirror)
}

/** 开始收集输出，须和抓取初始画面在同一轮同步代码里。返回值在画面送达后调用，开始发送。 */
export function beginTerminalMirror(id: string): () => void {
  const mirror: Mirror = { queue: [], open: false, pumping: false }
  mirrors.set(id, mirror)
  return () => {
    if (mirrors.get(id) !== mirror) return
    mirror.open = true
    void pump(id, mirror)
  }
}

export function forwardTerminalMirrorOutput(id: string, bytes: Uint8Array) {
  enqueue(id, { kind: 'bytes', bytes })
}

export function forwardTerminalMirrorScreen(id: string, screen: { data: string; cols: number; rows: number }) {
  enqueue(id, { kind: 'screen', ...screen })
}

/** 排在已收集的输出之后，手机先看完最后的内容再看到退出。 */
export function finishTerminalMirror(id: string, exitCode: number, disconnected: boolean) {
  enqueue(id, { kind: 'finish', exitCode, disconnected })
}

export function stopTerminalMirror(id: string) {
  mirrors.delete(id)
}

export function isTerminalMirrored(id: string) {
  return mirrors.has(id)
}
