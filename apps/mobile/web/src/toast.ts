import { create } from 'zustand'

/** 悬浮提示的语气：info 普通、ok 成功、warn 提醒、error 失败。 */
export type ToastTone = 'info' | 'ok' | 'warn' | 'error'

export type ToastOptions = {
  tone?: ToastTone
  /** 自动关闭的毫秒数；不传按语气和长度估算，0 表示不自动关闭。 */
  duration?: number
  actionLabel?: string
  onAction?: () => void
  /** 同 key 的提示原地替换，适合字号这类连续变化的提示。 */
  key?: string
}

export type ToastItem = {
  id: number
  key?: string
  message: string
  tone: ToastTone
  duration: number
  actionLabel?: string
  onAction?: () => void
}

type ToastState = { items: ToastItem[] }

/** 同时最多显示的条数，超出时挤掉最早的一条，避免遮住页面。 */
export const MAX_TOASTS = 3
const BASE_DURATION: Record<ToastTone, number> = { info: 2500, ok: 2500, warn: 4000, error: 5000 }
const MAX_DURATION = 8000

/** 按语气给基础时长，长文本每个字多停留 40ms，最多 8 秒，保证读得完。 */
export function toastDuration(message: string, tone: ToastTone): number {
  return Math.min(MAX_DURATION, BASE_DURATION[tone] + Math.max(0, message.length - 20) * 40)
}

export const useToasts = create<ToastState>(() => ({ items: [] }))

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function arm(item: ToastItem): void {
  const previous = timers.get(item.id)
  if (previous !== undefined) clearTimeout(previous)
  timers.delete(item.id)
  if (item.duration > 0) timers.set(item.id, setTimeout(() => dismissToast(item.id), item.duration))
}

/** 显示一条悬浮提示，返回 id；与正在显示的同文同语气提示合并并重新计时。 */
export function toast(message: string, options: ToastOptions = {}): number {
  const text = message.trim()
  if (!text) return 0
  const tone = options.tone ?? 'info'
  const duration = options.duration ?? toastDuration(text, tone)
  const items = useToasts.getState().items
  const same = items.find((item) => options.key ? item.key === options.key
    : !item.key && item.message === text && item.tone === tone)
  const item: ToastItem = {
    id: same?.id ?? nextId++,
    ...(options.key ? { key: options.key } : {}),
    message: text,
    tone,
    duration,
    ...(options.actionLabel && options.onAction ? { actionLabel: options.actionLabel, onAction: options.onAction } : {}),
  }
  let next = same ? items.map((value) => value.id === item.id ? item : value) : [...items, item]
  while (next.length > MAX_TOASTS) {
    const [oldest] = next
    next = next.slice(1)
    if (oldest) clearToastTimer(oldest.id)
  }
  useToasts.setState({ items: next })
  arm(item)
  return item.id
}

function clearToastTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
}

export function dismissToast(id: number): void {
  clearToastTimer(id)
  const items = useToasts.getState().items
  if (items.some((item) => item.id === id)) useToasts.setState({ items: items.filter((item) => item.id !== id) })
}

export function clearToasts(): void {
  for (const id of timers.keys()) clearToastTimer(id)
  useToasts.setState({ items: [] })
}
