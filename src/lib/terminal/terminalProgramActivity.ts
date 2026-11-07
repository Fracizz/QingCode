/**
 * 电脑终端的「程序正在工作」状态：根据程序设置的原始窗口标题（OSC 0/1/2）判断。
 * 与手机会话的 `programBusy`（src-tauri/src/mobile.rs 的 `program_busy_at`）规则一致：
 * 标题以转圈帧字符开头，或最近 SPINNER_HOLD 内出现过转圈帧，即视为运行中。
 * 标签名使用清洗后的标题（会去掉开头的转圈字符），所以这里单独记录原始标题。
 */

/** 转圈帧之间的空档保持「运行中」，避免状态随动画闪烁。须与后端 SPINNER_HOLD 一致。 */
export const SPINNER_HOLD_MS = 3000

type Listener = (terminalId: string) => void

interface Activity {
  title: string
  lastFrame: number | null
  timer: ReturnType<typeof setTimeout> | null
}

const activities = new Map<string, Activity>()
const listeners = new Set<Listener>()

/** 标题开头的转圈帧字符：盲文点阵（含空白帧）与常见的圆形/方块转圈。 */
export function isSpinnerGlyph(character: string | undefined): boolean {
  return !!character && /^[⠀-⣿◐-◓◢-◥◰-◷]$/u.test(character)
}

/** 拆出标题开头的单个符号（非字母数字、非空白，后面跟空白）与其后的文本。 */
function splitTitleGlyph(title: string): [string, string] | null {
  const [first, ...restChars] = [...title]
  if (!first || /[\p{L}\p{N}\s]/u.test(first)) return null
  const rest = restChars.join('')
  if (!/^\s/u.test(rest)) return null
  const text = rest.trimStart()
  return text ? [first, text] : null
}

/**
 * 这次标题变化是否为一帧转圈动画：新标题以已知转圈字符开头，
 * 或只有开头的符号变了、其后的文字不变（兼容未知的转圈字符）。
 */
export function isSpinnerFrame(previous: string | null | undefined, current: string): boolean {
  if (isSpinnerGlyph([...current][0])) return true
  const before = previous ? splitTitleGlyph(previous) : null
  const after = splitTitleGlyph(current)
  return !!before && !!after && before[0] !== after[0] && before[1] === after[1]
}

function notify(terminalId: string) {
  for (const listener of listeners) listener(terminalId)
}

/** 记录终端程序设置的原始标题（未清洗）。 */
export function noteTerminalTitle(terminalId: string, rawTitle: string, now = Date.now()) {
  const title = rawTitle.trim()
  const activity = activities.get(terminalId) ?? { title: '', lastFrame: null, timer: null }
  const wasBusy = isTerminalProgramBusy(terminalId, now)
  if (isSpinnerFrame(activity.title || null, title)) {
    activity.lastFrame = now
    // 保持时间到期后通知一次，让列表从「运行中」切回。
    if (activity.timer) clearTimeout(activity.timer)
    activity.timer = setTimeout(() => {
      activity.timer = null
      notify(terminalId)
    }, SPINNER_HOLD_MS)
  }
  activity.title = title
  activities.set(terminalId, activity)
  if (wasBusy !== isTerminalProgramBusy(terminalId, now)) notify(terminalId)
}

/** 终端程序是否正在工作（标题在转圈）。 */
export function isTerminalProgramBusy(terminalId: string, now = Date.now()): boolean {
  const activity = activities.get(terminalId)
  if (!activity) return false
  if (isSpinnerGlyph([...activity.title][0])) return true
  return activity.lastFrame !== null && now - activity.lastFrame < SPINNER_HOLD_MS
}

export function clearTerminalProgramActivity(terminalId: string) {
  const activity = activities.get(terminalId)
  if (!activity) return
  if (activity.timer) clearTimeout(activity.timer)
  activities.delete(terminalId)
  notify(terminalId)
}

export function subscribeTerminalProgramActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
