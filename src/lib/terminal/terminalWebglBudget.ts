/**
 * 终端 WebGL 上下文预算。
 *
 * Chromium / WebView2 每页最多同时保留约 16 个 WebGL 上下文，超出后浏览器会强行
 * 回收最旧的一个——可能正是用户眼前的终端。这里给终端留出确定的预算：超额时主动
 * 回收「当前不可见且最久没用」的终端（退回 DOM 渲染），可见终端再次用到时重新申请。
 */
export const TERMINAL_WEBGL_BUDGET = 10

interface WebglSlotHolder {
  lastUsed: number
  isVisible: () => boolean
  release: () => void
}

const holders = new Map<string, WebglSlotHolder>()
let clock = 0

/**
 * 申请（或刷新）一个 WebGL 槽位。预算已满时回收最久未用的不可见终端；
 * 全部持有者都可见时返回 `false`，调用方保持 DOM 渲染。
 */
export function acquireTerminalWebglSlot(
  key: string,
  isVisible: () => boolean,
  release: () => void,
  budget: number = TERMINAL_WEBGL_BUDGET
): boolean {
  const existing = holders.get(key)
  if (existing) {
    existing.lastUsed = ++clock
    existing.isVisible = isVisible
    existing.release = release
    return true
  }
  while (holders.size >= budget) {
    const victim = pickVictim()
    if (!victim) return false
    holders.delete(victim[0])
    try {
      victim[1].release()
    } catch {}
  }
  holders.set(key, { lastUsed: ++clock, isVisible, release })
  return true
}

/** 标记终端刚被使用（激活、可见），降低被回收的优先级。 */
export function touchTerminalWebglSlot(key: string) {
  const holder = holders.get(key)
  if (holder) holder.lastUsed = ++clock
}

/** 归还槽位（终端卸载或上下文丢失）；不会调用 `release`。 */
export function releaseTerminalWebglSlot(key: string) {
  holders.delete(key)
}

export function terminalWebglSlotCount(): number {
  return holders.size
}

function pickVictim(): [string, WebglSlotHolder] | undefined {
  let victim: [string, WebglSlotHolder] | undefined
  for (const entry of holders) {
    let visible = true
    try {
      visible = entry[1].isVisible()
    } catch {}
    if (visible) continue
    if (!victim || entry[1].lastUsed < victim[1].lastUsed) victim = entry
  }
  return victim
}

/** 仅供测试：清空全部槽位。 */
export function resetTerminalWebglSlotsForTest() {
  holders.clear()
  clock = 0
}
