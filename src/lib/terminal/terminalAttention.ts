/**
 * 终端「待查看」标记：看不到的终端里任务结束或进程退出后，在工作台列表上提示。
 * 只保存在内存中，重启应用后清空；看到该终端（成为当前终端）时清除。
 */
type Listener = () => void

let attention: ReadonlySet<string> = new Set()
/** 正在工作的终端，用来识别「工作 → 空闲」的翻转。 */
const busyTerminals = new Set<string>()
/** 终端最近一次离开视野的时间。 */
const leftViewAt = new Map<string, number>()
const listeners = new Set<Listener>()

function replaceAttention(next: ReadonlySet<string>) {
  attention = next
  for (const listener of listeners) listener()
}

export function markTerminalAttention(terminalId: string) {
  if (attention.has(terminalId)) return
  replaceAttention(new Set(attention).add(terminalId))
}

export function clearTerminalAttention(terminalId: string) {
  if (!attention.has(terminalId)) return
  const next = new Set(attention)
  next.delete(terminalId)
  replaceAttention(next)
}

export function noteTerminalLeftView(terminalId: string, now = Date.now()) {
  leftViewAt.set(terminalId, now)
}

/** 上次同步时显示在界面上的终端。 */
let terminalsInView: ReadonlySet<string> = new Set()

/**
 * 同步此刻显示在界面上的终端：离开视野的记下时间，在视野内的清除标记。
 * 进入视野不只是切换当前终端：切回项目时当前终端可能没变，分屏的副窗格也会显示终端，
 * 只看当前终端是否变化会漏掉这些情况，用户看过后标记仍在。
 */
export function syncTerminalsInView(inView: ReadonlySet<string>, now = Date.now()) {
  for (const id of terminalsInView) {
    if (!inView.has(id)) noteTerminalLeftView(id, now)
  }
  terminalsInView = inView
  for (const id of inView) clearTerminalAttention(id)
}

/**
 * 记录程序工作状态的翻转；看不到的终端从工作转为空闲时标记。
 * lastWorkAt 是最后的工作信号时间：早于切走时刻说明用户看着它结束，只是保持期切走后才到期。
 */
export function noteTerminalBusyChange(
  terminalId: string,
  busy: boolean,
  inView: boolean,
  lastWorkAt = Date.now(),
) {
  if (busy) {
    busyTerminals.add(terminalId)
    return
  }
  if (!busyTerminals.delete(terminalId) || inView) return
  const leftAt = leftViewAt.get(terminalId)
  if (leftAt !== undefined && lastWorkAt < leftAt) return
  markTerminalAttention(terminalId)
}

/** 终端关闭后丢弃它的记录。 */
export function pruneTerminalAttention(existingIds: ReadonlySet<string>) {
  for (const id of busyTerminals) {
    if (!existingIds.has(id)) busyTerminals.delete(id)
  }
  for (const id of leftViewAt.keys()) {
    if (!existingIds.has(id)) leftViewAt.delete(id)
  }
  if ([...terminalsInView].some(id => !existingIds.has(id))) {
    terminalsInView = new Set([...terminalsInView].filter(id => existingIds.has(id)))
  }
  if ([...attention].every(id => existingIds.has(id))) return
  replaceAttention(new Set([...attention].filter(id => existingIds.has(id))))
}

/** 只在内容变化时换新引用，可直接用于 useSyncExternalStore。 */
export function getTerminalAttentionSnapshot(): ReadonlySet<string> {
  return attention
}

export function subscribeTerminalAttention(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
