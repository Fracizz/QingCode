import { translate } from '../i18n'
import { useProjectStore } from '../../store/projectStore'

/** 最后一个终端接回后再等这么久没有新的接回，才汇总成一条提示：并发接回的多个终端只提示一次。 */
export const REATTACH_NOTICE_SETTLE_MS = 3000

const pending = new Set<string>()
let count = 0
let timer: ReturnType<typeof setTimeout> | undefined
let done = false

function flush() {
  timer = undefined
  done = true
  pending.clear()
  if (count > 0) useProjectStore.getState().pushToast('success', translate('已接回 {n} 个终端', { n: count }))
}

/**
 * 重启后接回终端的汇总提示（右下角一条，几秒后自动消失）：
 * 启动恢复的标签（及后台发现的远端遗留终端）登记后，接回成功一个计一个，
 * 停顿 {@link REATTACH_NOTICE_SETTLE_MS} 后只弹一次；之后的断线重连等接回不再提示。
 */
export function trackStartupReattach(ids: Iterable<string>) {
  if (done) return
  for (const id of ids) pending.add(id)
}

/** 标签成功接回原进程（不含接回失败后按原配置新建）时调用。 */
export function noteTerminalReattached(id: string) {
  if (done || !pending.delete(id)) return
  count += 1
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(flush, REATTACH_NOTICE_SETTLE_MS)
}

/** 测试用：恢复初始状态。 */
export function resetReattachNoticeForTests() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  pending.clear()
  count = 0
  done = false
}
