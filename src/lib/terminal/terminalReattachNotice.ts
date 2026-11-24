import { translate } from '../i18n'
import { useProjectStore } from '../../store/projectStore'

const pending = new Set<string>()
let done = false

/**
 * 重启后接回终端的提示（右下角一条，几秒后自动消失）：
 * 启动恢复的标签（及后台发现的远端遗留终端）登记后，第一个真正开始接回原进程时提示一次，不显示个数；
 * 之后的断线重连等接回不再提示。
 */
export function trackStartupReattach(ids: Iterable<string>) {
  if (done) return
  for (const id of ids) pending.add(id)
}

/** 标签开始接回原进程时调用（接回请求已发出，不含按原配置新建）。 */
export function noteTerminalReattaching(id: string) {
  if (done || !pending.has(id)) return
  done = true
  pending.clear()
  useProjectStore.getState().pushToast('info', translate('正在后台接回上次的终端…'))
}

/** 测试用：恢复初始状态。 */
export function resetReattachNoticeForTests() {
  pending.clear()
  done = false
}
