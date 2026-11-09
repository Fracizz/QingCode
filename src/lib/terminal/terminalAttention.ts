/**
 * 终端「待查看」标记：看不到的终端里任务结束或进程退出后，在工作台列表上提示。
 * 只保存在内存中，重启应用后清空；看到该终端（成为当前终端）时清除。
 */
type Listener = () => void

let attention: ReadonlySet<string> = new Set()
/** 正在工作的终端，用来识别「工作 → 空闲」的翻转。 */
const busyTerminals = new Set<string>()
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

/** 记录程序工作状态的翻转；看不到的终端从工作转为空闲时标记。 */
export function noteTerminalBusyChange(terminalId: string, busy: boolean, inView: boolean) {
  if (busy) {
    busyTerminals.add(terminalId)
    return
  }
  if (busyTerminals.delete(terminalId) && !inView) markTerminalAttention(terminalId)
}

/** 终端关闭后丢弃它的记录。 */
export function pruneTerminalAttention(existingIds: ReadonlySet<string>) {
  for (const id of busyTerminals) {
    if (!existingIds.has(id)) busyTerminals.delete(id)
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
