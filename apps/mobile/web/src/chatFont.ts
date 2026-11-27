export const DEFAULT_CHAT_FONT = 14
export const MIN_CHAT_FONT = 8
export const MAX_CHAT_FONT = 32
const storageKey = 'qn.mobile.chatFontSize'
let sessionSize: number | undefined

export function fitChatFont(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_CHAT_FONT, Math.max(MIN_CHAT_FONT, Math.round(value))) : DEFAULT_CHAT_FONT
}

export function readChatFont(): number {
  if (sessionSize !== undefined) return sessionSize
  try {
    const value = localStorage.getItem(storageKey)
    return value && value.trim() ? fitChatFont(Number(value)) : DEFAULT_CHAT_FONT
  } catch {
    return DEFAULT_CHAT_FONT
  }
}

export function saveChatFont(value: number): boolean {
  const size = fitChatFont(value)
  try {
    localStorage.setItem(storageKey, String(size))
    sessionSize = undefined
    return true
  } catch {
    sessionSize = size
    return false
  }
}

/** onScale 在缩放中回报当前字号，手势结束回报 null，供界面显示字号提示。 */
export function bindChatPinch(root: HTMLElement, onScale?: (size: number | null) => void): () => void {
  let size = readChatFont()
  let gesture: { distance: number; size: number; ids: number[] } | null = null
  const apply = () => root.style.setProperty('--chat-font', size + 'px')
  apply()
  function finish() {
    if (!gesture) return
    gesture = null
    saveChatFont(size)
    onScale?.(null)
  }
  function update(event: TouchEvent) {
    const touches = Array.from(event.touches)
    if (touches.length !== 2 || touches.some((touch) => !root.contains(touch.target as Node))) {
      finish()
      return
    }
    const [first, second] = touches as [Touch, Touch]
    const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
    if (distance < 1) return
    if (event.cancelable) event.preventDefault()
    if (!gesture || !touches.every((touch) => gesture?.ids.includes(touch.identifier))) {
      gesture = { distance, size, ids: touches.map((touch) => touch.identifier) }
      onScale?.(size)
      return
    }
    const next = fitChatFont(gesture.size * distance / gesture.distance)
    if (next === size) return
    size = next
    apply()
    onScale?.(size)
  }
  const events = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const
  for (const name of events) root.addEventListener(name, update, { passive: false })
  return () => {
    for (const name of events) root.removeEventListener(name, update)
    finish()
  }
}
