import type { TerminalTab } from '@/types'

/**
 * 终端标签活动状态：只区分「运行中」和「已完成未查看」，其余情况不显示。
 * 信号来源与刷新节奏见 terminalActivityTracker.ts。
 */
export type TerminalActivityPhase = 'idle' | 'running' | 'unseen'

export interface TerminalActivityState {
  phase: TerminalActivityPhase
  runningSince: number | null
  /** 进入运行中时依据的信号；用于区分 Agent 刚启动与真正干完活。 */
  source: 'title' | 'process' | null
}

export const IDLE_TERMINAL_ACTIVITY: TerminalActivityState = {
  phase: 'idle',
  runningSince: null,
  source: null,
}

/** 运行不足这个时长的任务结束时不打「已完成」，避免短命令造成干扰。 */
export const MIN_RUN_FOR_UNSEEN_MS = 3000
/** 转圈帧之后保持忙碌的时长，与 `SPINNER_HOLD`（src-tauri/src/mobile.rs）一致。 */
export const TITLE_SPINNER_HOLD_MS = 3000

export interface TerminalActivityInput {
  status: TerminalTab['status']
  /** 标题表明这是自报状态的 Agent：只信标题，不看子进程（Agent 本身就是子进程）。 */
  agentTitle: boolean
  spinnerActive: boolean
  oneShot: boolean
  hasChildren: boolean
  /** 标签正显示在屏幕上且窗口有焦点。 */
  viewed: boolean
}

/** 纯状态转换；状态不变时返回原对象。 */
export function nextTerminalActivity(
  prev: TerminalActivityState,
  input: TerminalActivityInput,
  now: number,
): TerminalActivityState {
  if (input.status === 'starting') return IDLE_TERMINAL_ACTIVITY
  // 断线重连期间拿不到可靠信号，保持原状，避免把断线当成完成。
  if (input.status === 'reconnecting') return prev

  const alive = input.status === 'running'
  const titleRunning = alive && input.spinnerActive
  const processRunning = alive && !input.agentTitle && (input.oneShot || input.hasChildren)

  if (titleRunning || processRunning) {
    const source = titleRunning ? 'title' : 'process'
    if (prev.phase === 'running' && prev.source === source) return prev
    return {
      phase: 'running',
      runningSince: prev.phase === 'running' ? prev.runningSince : now,
      source,
    }
  }

  if (prev.phase === 'running') {
    // 子进程探测先于 Agent 设置标题生效：这段启动过程不算完成了任务。
    const agentStartup = prev.source === 'process' && input.agentTitle
    const ranLongEnough = now - (prev.runningSince ?? now) >= MIN_RUN_FOR_UNSEEN_MS
    return !input.viewed && ranLongEnough && !agentStartup
      ? { phase: 'unseen', runningSince: null, source: null }
      : IDLE_TERMINAL_ACTIVITY
  }
  return prev.phase === 'unseen' && input.viewed ? IDLE_TERMINAL_ACTIVITY : prev
}

/** 须与 `is_spinner_glyph`（src-tauri/src/mobile.rs）和手机端 protocol.js 保持一致。 */
const SPINNER_START = /^[⠀-⣿◐-◓◢-◥◰-◷]/u
/** 开头单个符号 + 空白 + 文字，如 `| build`；对应 mobile.rs 的 `split_title_glyph`。 */
const TITLE_GLYPH = /^([^\p{L}\p{N}\s])\s+(\S.*)$/su
/** 用符号前缀自报状态的程序，如 Claude Code 的 `✳ 任务名`。ASCII 符号不算，避免误伤路径类标题。 */
const AGENT_TITLE = /^\p{So}(?:\s|$)/u

export function isSpinnerTitleFrame(previous: string | null, current: string): boolean {
  if (SPINNER_START.test(current)) return true
  if (previous === null) return false
  const before = TITLE_GLYPH.exec(previous)
  const after = TITLE_GLYPH.exec(current)
  return !!before && !!after && before[1] !== after[1] && before[2] === after[2]
}

export function isAgentStatusTitle(title: string): boolean {
  return AGENT_TITLE.test(title)
}

interface TitleSignal {
  title: string
  lastSpinnerAt: number | null
}

const titleSignals = new Map<string, TitleSignal>()

/**
 * 记录程序设置的原始窗口标题（清洗前，转圈符号还在）。开关关闭时也只是写一次 Map；
 * 这样中途开启时已打开的 Agent 能立刻被识别，而不是显示为一直运行。
 */
export function recordTerminalTitle(terminalId: string, title: string, now = Date.now()) {
  const previous = titleSignals.get(terminalId)
  titleSignals.set(terminalId, {
    title,
    lastSpinnerAt: isSpinnerTitleFrame(previous?.title ?? null, title)
      ? now
      : (previous?.lastSpinnerAt ?? null),
  })
}

export function clearTerminalTitleSignal(terminalId: string) {
  titleSignals.delete(terminalId)
}

export function terminalTitleSignal(terminalId: string, now: number) {
  const signal = titleSignals.get(terminalId)
  if (!signal) return { agentTitle: false, spinnerActive: false }
  return {
    agentTitle: isAgentStatusTitle(signal.title),
    spinnerActive:
      SPINNER_START.test(signal.title) ||
      (signal.lastSpinnerAt !== null && now - signal.lastSpinnerAt < TITLE_SPINNER_HOLD_MS),
  }
}

const states = new Map<string, TerminalActivityState>()
const listeners = new Set<() => void>()

export function getTerminalActivityPhase(terminalId: string): TerminalActivityPhase {
  return states.get(terminalId)?.phase ?? 'idle'
}

export function getTerminalActivityState(terminalId: string): TerminalActivityState {
  return states.get(terminalId) ?? IDLE_TERMINAL_ACTIVITY
}

export function subscribeTerminalActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 整表替换一轮结果；显示上的阶段都没变时不通知，标签栏不会重新渲染。 */
export function publishTerminalActivity(next: ReadonlyMap<string, TerminalActivityState>) {
  let changed = false
  for (const id of new Set([...states.keys(), ...next.keys()])) {
    if ((states.get(id)?.phase ?? 'idle') !== (next.get(id)?.phase ?? 'idle')) changed = true
  }
  states.clear()
  for (const [id, state] of next) {
    if (state !== IDLE_TERMINAL_ACTIVITY) states.set(id, state)
  }
  if (changed) listeners.forEach(listener => listener())
}
