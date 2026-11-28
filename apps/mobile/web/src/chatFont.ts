export const DEFAULT_CHAT_FONT = 16
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

/** 两指间距变化超过这个值（CSS px）才算缩放：轻触、两指平移和三指手势都不触发。 */
export const PINCH_SLOP = 24

/** onScale 在缩放中回报当前字号，手势结束回报 null，供界面显示字号提示。 */
export function bindChatPinch(root: HTMLElement, onScale?: (size: number | null) => void): () => void {
  let size = readChatFont()
  // base 是越过阈值后的参照间距；null 表示两指已按下但还不算缩放。
  let gesture: { start: number; base: number | null; size: number; ids: number[] } | null = null
  let blocked = false
  const apply = () => root.style.setProperty('--chat-font', size + 'px')
  apply()
  function finish() {
    const scaled = gesture !== null && gesture.base !== null
    gesture = null
    if (!scaled) return
    saveChatFont(size)
    onScale?.(null)
  }
  function update(event: TouchEvent) {
    const touches = Array.from(event.touches)
    // 出现过三指就整轮忽略，直到手指全部抬起：系统三指手势抬手时会经过两指状态。
    if (touches.length === 0 || (event.type === 'touchstart' && touches.length === 1)) blocked = false
    if (touches.length > 2) blocked = true
    if (blocked || touches.length !== 2 || touches.some((touch) => !root.contains(touch.target as Node))) {
      finish()
      return
    }
    const [first, second] = touches as [Touch, Touch]
    const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
    if (distance < 1) return
    if (event.cancelable) event.preventDefault()
    if (!gesture || !touches.every((touch) => gesture?.ids.includes(touch.identifier))) {
      finish()
      gesture = { start: distance, base: null, size, ids: touches.map((touch) => touch.identifier) }
      return
    }
    const starting = gesture.base === null
    if (starting) {
      const delta = distance - gesture.start
      if (Math.abs(delta) < PINCH_SLOP) return
      // 从阈值处起算比例，字号不会在触发瞬间跳变。
      gesture.base = gesture.start + Math.sign(delta) * PINCH_SLOP
    }
    const next = fitChatFont(gesture.size * distance / gesture.base!)
    if (next === size && !starting) return
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
