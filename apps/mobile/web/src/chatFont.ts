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
