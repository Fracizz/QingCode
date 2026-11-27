const twoDigits = (value: number) => String(value).padStart(2, '0')

export function localReplyDay(timestamp = Date.now()): number {
  return new Date(timestamp).setHours(0, 0, 0, 0)
}

export function formatReplyTime(timestamp: number, today: number) {
  const date = new Date(timestamp)
  if (timestamp <= 0 || !Number.isFinite(date.getTime())) return null
  const day = [date.getFullYear(), twoDigits(date.getMonth() + 1), twoDigits(date.getDate())].join('-')
  const time = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
  const full = `${day} ${time}`
  return { label: localReplyDay(timestamp) === today ? time : full, full, dateTime: date.toISOString() }
}

const subscribers = new Set<() => void>()
let midnightTimer: ReturnType<typeof setTimeout> | undefined

function scheduleMidnight() {
  if (midnightTimer !== undefined || subscribers.size === 0) return
  const tomorrow = new Date(localReplyDay())
  tomorrow.setDate(tomorrow.getDate() + 1)
  midnightTimer = setTimeout(() => {
    midnightTimer = undefined
    for (const subscriber of subscribers) subscriber()
    scheduleMidnight()
  }, Math.max(1, tomorrow.getTime() - Date.now()))
}

export function subscribeToReplyDay(callback: () => void): () => void {
  subscribers.add(callback)
  scheduleMidnight()
  return () => {
    subscribers.delete(callback)
    if (subscribers.size > 0) return
    clearTimeout(midnightTimer)
    midnightTimer = undefined
  }
}
