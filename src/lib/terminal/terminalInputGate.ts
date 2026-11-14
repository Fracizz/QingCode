import { terminalControl } from '@/store/terminalControlStore'

/**
 * CLI / AI 往终端写入时与人的输入协调（参考 herdr-core 的 Gate）：
 * - 人刚打过字（任一端，默认 3 秒内）先等安静下来再写，免得和人的按键交错；
 * - 电脑上有没提交的草稿（打了字还没回车）时最多再等 60 秒，等人发出或清空；
 * - 超过上限照常写入，不会无限等待。
 * 手机等其他设备没有草稿信息，只按它们最近一次输入的时间等安静。
 */
export const INPUT_QUIET_MS = 3000
export const DRAFT_WAIT_MS = 60_000

interface HumanInput {
  lastAt: number
  /** 最近一次回车之后又打过字：电脑上有没提交的草稿。 */
  draftSince: number | null
}

const humanInputs = new Map<string, HumanInput>()

/** 记录电脑上的一次人工输入。回车结束草稿；其他内容开启或延续草稿。 */
export function noteHumanTerminalInput(id: string, data: string, now = Date.now()) {
  const previous = humanInputs.get(id)
  const submitted = /[\r\n]/.test(data)
  const draftSince = submitted ? null : previous?.draftSince ?? now
  humanInputs.set(id, { lastAt: now, draftSince })
}

export function forgetHumanTerminalInput(id: string) {
  humanInputs.delete(id)
}

/** 还要等多久才能写入；0 表示可以写。`startedAt` 是开始等待的时间，用来封顶。 */
export function inputGateDelay(id: string, startedAt: number, now = Date.now()): number {
  const local = humanInputs.get(id)
  const remote = terminalControl(id)?.lastInput
  const remoteAt = remote && remote.kind === 'device' ? remote.at : 0
  const lastAt = Math.max(local?.lastAt ?? 0, remoteAt)
  const quietLeft = lastAt > 0 ? lastAt + INPUT_QUIET_MS - now : 0
  const draftLeft = local?.draftSince != null ? startedAt + DRAFT_WAIT_MS - now : 0
  const capLeft = startedAt + INPUT_QUIET_MS + DRAFT_WAIT_MS - now
  if (capLeft <= 0) return 0
  return Math.max(0, Math.min(capLeft, Math.max(quietLeft, draftLeft)))
}

/** 等到可以写入为止（人停止输入、草稿已提交，或到达上限）。 */
export async function waitForHumanInputQuiet(
  id: string,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => number = Date.now,
) {
  const startedAt = now()
  for (;;) {
    const delay = inputGateDelay(id, startedAt, now())
    if (delay <= 0) return
    await sleep(Math.min(delay, 500))
  }
}
