/**
 * 电脑终端的「程序正在工作」状态。程序用 OSC 7501 主动上报时（Codex、OpenCode）以上报为准；
 * 上报在用户回车提交后失效（OpenCode 退出时不撤销，否则会盖住之后的 Shell 命令），由程序重新上报；
 * 屏幕快照不带窗口标题和上报，收到快照时也一并作废，否则断线期间错过的结束信号会让状态永远停在运行中。
 * 视图挂载时回放的历史同理：只取标题文字，其中的转圈帧和上报都不算信号。
 * 没有上报时，两路信号任一成立即视为运行中：
 * 1. 标题转圈（强信号）：程序设置的原始窗口标题（OSC 0/1/2）以转圈帧字符开头，
 *    或最近 SPINNER_HOLD 内出现过转圈帧。适合 Claude Code / Codex 等 AI CLI。
 * 2. 输出活跃（弱信号）：持续输出至少 OUTPUT_STREAK_MS，且最近 SPINNER_HOLD 内仍有输出。
 *    覆盖 build / test / 日志等不改标题的命令。紧跟输入或改尺寸的输出（回显、重绘）不计；
 *    shell 集成（OSC 133/633）明确报告停在提示符时也不计。
 * 上述规则须与 src-tauri/src/mobile.rs 的手机会话 `programBusy` 一致。
 *
 * 性能：每块输出只做 O(1) 的时间戳记录，不逐块通知；状态翻转时才通知，
 * 并且每个终端最多挂一个到期定时器。不轮询进程树。
 */
import type { TerminalProgramReport } from '@/utils/terminalOsc'
import { getTerminalCommandRunning } from './terminalCommandActivity'

/** 转圈帧/输出之间的空档保持「运行中」，避免状态闪烁。须与后端 SPINNER_HOLD 一致。 */
export const SPINNER_HOLD_MS = 3000
/** 输入或改尺寸之后这段时间内的输出视为回显/重绘。须与后端 OUTPUT_QUIET_AFTER_INPUT 一致。 */
export const OUTPUT_QUIET_AFTER_INPUT_MS = 500
/** 输出需连续这么久才算运行中，过滤提示符重绘、一次性的短输出。须与后端 OUTPUT_STREAK 一致。 */
export const OUTPUT_STREAK_MS = 1000

type Listener = (terminalId: string) => void

interface Activity {
  title: string
  lastFrame: number | null
  /** 最近一次输入或改尺寸。 */
  lastInput: number | null
  /** 当前这段连续输出的开始时间（间隔达到 SPINNER_HOLD 即断开）。 */
  streakStart: number | null
  lastOutput: number | null
  /** 程序主动上报的状态；有值时不看标题和输出。 */
  reported: Exclude<TerminalProgramReport, 'clear'> | null
  /** 上次通知时的状态，只在翻转时通知。 */
  busy: boolean
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

function activityFor(terminalId: string): Activity {
  let activity = activities.get(terminalId)
  if (!activity) {
    activity = {
      title: '',
      lastFrame: null,
      lastInput: null,
      streakStart: null,
      lastOutput: null,
      reported: null,
      busy: false,
      timer: null,
    }
    activities.set(terminalId, activity)
  }
  return activity
}

function outputBusy(terminalId: string, activity: Activity, now: number): boolean {
  const { lastOutput, streakStart } = activity
  if (lastOutput === null || streakStart === null) return false
  if (now - lastOutput >= SPINNER_HOLD_MS || lastOutput - streakStart < OUTPUT_STREAK_MS) return false
  // shell 集成明确说停在提示符：输出只是提示符/补全重绘。
  return getTerminalCommandRunning(terminalId) !== false
}

function computeBusy(terminalId: string, activity: Activity, now: number): boolean {
  if (activity.reported) return activity.reported === 'working'
  if (isSpinnerGlyph([...activity.title][0])) return true
  if (activity.lastFrame !== null && now - activity.lastFrame < SPINNER_HOLD_MS) return true
  return outputBusy(terminalId, activity, now)
}

/** 状态翻转时通知；仍在运行且会自然到期时，挂一个到期定时器（已挂则不重排）。 */
function refresh(terminalId: string, activity: Activity, now: number) {
  const busy = computeBusy(terminalId, activity, now)
  if (busy !== activity.busy) {
    activity.busy = busy
    notify(terminalId)
  }
  if (!busy || activity.timer || activity.reported || isSpinnerGlyph([...activity.title][0])) return
  const expiry = Math.max(activity.lastFrame ?? 0, activity.lastOutput ?? 0) + SPINNER_HOLD_MS
  activity.timer = setTimeout(() => {
    activity.timer = null
    if (activities.get(terminalId) === activity) refresh(terminalId, activity, Date.now())
  }, Math.max(0, expiry - now))
}

/** 记录终端程序设置的原始标题（未清洗）。 */
export function noteTerminalTitle(terminalId: string, rawTitle: string, now = Date.now()) {
  const title = rawTitle.trim()
  const activity = activityFor(terminalId)
  if (isSpinnerFrame(activity.title || null, title)) activity.lastFrame = now
  activity.title = title
  refresh(terminalId, activity, now)
}

function withoutSpinnerGlyph(title: string): string {
  const [first, ...rest] = [...title]
  return isSpinnerGlyph(first) ? rest.join('').trimStart() : title
}

/**
 * 记录回放历史里的标题：只保留文字，历史说明不了程序现在的状态。
 * 否则旧转圈帧会让已结束的终端在挂载后「运行」几秒，再被当成刚完成。
 */
export function noteTerminalReplayedTitle(terminalId: string, rawTitle: string, now = Date.now()) {
  const activity = activityFor(terminalId)
  activity.title = withoutSpinnerGlyph(rawTitle.trim())
  refresh(terminalId, activity, now)
}

/** 程序最近设置的原始窗口标题（未清洗）。 */
export function getTerminalProgramTitle(terminalId: string): string {
  return activities.get(terminalId)?.title ?? ''
}

/** 记录程序通过 OSC 7501 上报的状态。 */
export function noteTerminalProgramState(
  terminalId: string,
  state: TerminalProgramReport,
  now = Date.now(),
) {
  const activity = activityFor(terminalId)
  activity.reported = state === 'clear' ? null : state
  refresh(terminalId, activity, now)
}

/** 用户回车提交：之前的上报可能来自已退出的程序，作废后等程序重新上报。 */
export function noteTerminalSubmit(terminalId: string, now = Date.now()) {
  const activity = activities.get(terminalId)
  if (!activity?.reported) return
  activity.reported = null
  refresh(terminalId, activity, now)
}

/**
 * 视图写入了屏幕快照：快照之前的上报和标题转圈帧都可能已过期。
 * 只去掉转圈字符、保留标题文字；程序若仍在工作，下一帧转圈会马上恢复状态。
 */
export function noteTerminalScreenSnapshot(terminalId: string, now = Date.now()) {
  const activity = activities.get(terminalId)
  if (!activity) return
  activity.reported = null
  activity.title = withoutSpinnerGlyph(activity.title)
  refresh(terminalId, activity, now)
}

/** 记录一块程序输出（不含回放/快照）。 */
export function noteTerminalOutput(terminalId: string, now = Date.now()) {
  const activity = activityFor(terminalId)
  if (activity.lastInput !== null && now - activity.lastInput < OUTPUT_QUIET_AFTER_INPUT_MS) return
  if (activity.lastOutput === null || now - activity.lastOutput >= SPINNER_HOLD_MS) {
    activity.streakStart = now
  }
  activity.lastOutput = now
  // 连续输出期间状态不变，跳过计算，避免逐块开销。
  if (activity.busy && activity.timer) return
  refresh(terminalId, activity, now)
}

/** 记录一次输入或改尺寸：随后短时间内的输出视为回显/重绘。 */
export function noteTerminalInput(terminalId: string, now = Date.now()) {
  activityFor(terminalId).lastInput = now
}

/** 终端程序是否正在工作（标题在转圈，或持续有输出）。 */
export function isTerminalProgramBusy(terminalId: string, now = Date.now()): boolean {
  const activity = activities.get(terminalId)
  return !!activity && computeBusy(terminalId, activity, now)
}

/**
 * 最近一次通知时的状态，不随时间变化；供 useSyncExternalStore 做稳定快照。
 * 状态到期翻转时会先更新这里再通知订阅者。
 */
export function getTerminalProgramBusySnapshot(terminalId: string): boolean {
  return activities.get(terminalId)?.busy ?? false
}

/**
 * 最后一次看到工作信号的时间，用来还原保持期到期前真正停下的时刻。
 * 主动上报没有保持期，翻转的此刻就是结束时刻。
 */
export function getTerminalLastWorkAt(terminalId: string, now = Date.now()): number {
  const activity = activities.get(terminalId)
  if (!activity || activity.reported) return now
  return Math.max(activity.lastFrame ?? 0, activity.lastOutput ?? 0)
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
