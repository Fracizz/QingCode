import type { ItemView } from '@qn/codex-client'

// 消息流分组（参考 Codex / Orca 的"已运行 3 条命令 · 1 个失败"）：
// 连续的工具类条目（命令、文件改动、思考、其他）折叠成一行摘要，对话正文不被过程信息淹没。

export type FlowEntry =
  | { kind: 'item'; key: string; item: ItemView }
  | { kind: 'tools'; key: string; items: ItemView[] }

const isTool = (item: ItemView): boolean =>
  item.kind === 'command' || item.kind === 'fileChange' || item.kind === 'reasoning' || item.kind === 'other'

/** 至少 2 个连续工具条目才分组；单个工具条目保持原样，免得多点一次才能看到。 */
export function groupFlow(items: ItemView[]): FlowEntry[] {
  const entries: FlowEntry[] = []
  let run: ItemView[] = []
  const flush = () => {
    if (run.length >= 2) entries.push({ kind: 'tools', key: `tools-${run[0]!.id}`, items: run })
    else for (const item of run) entries.push({ kind: 'item', key: item.id, item })
    run = []
  }
  for (const item of items) {
    if (isTool(item)) {
      run.push(item)
    } else {
      flush()
      entries.push({ kind: 'item', key: item.id, item })
    }
  }
  flush()
  return entries
}

const running = (status: string) => /progress|running|started/i.test(status)

export function isGroupRunning(items: ItemView[]): boolean {
  return items.some((item) =>
    item.kind === 'command' || item.kind === 'fileChange'
      ? running(item.status)
      : item.kind === 'reasoning'
        ? item.streaming === true
        : false,
  )
}

export function summarizeTools(items: ItemView[]): string {
  let commands = 0
  let failed = 0
  let files = 0
  let thoughts = 0
  let others = 0
  for (const item of items) {
    if (item.kind === 'command') {
      commands++
      const exit = item.exitCode
      if ((exit !== null && exit !== undefined && exit !== 0) || /fail|error|denied|declined/i.test(item.status)) failed++
    } else if (item.kind === 'fileChange') {
      files += Math.max(1, item.changes.length)
    } else if (item.kind === 'reasoning') {
      thoughts++
    } else {
      others++
    }
  }
  const parts: string[] = []
  if (commands) parts.push(`已运行 ${commands} 条命令`)
  if (failed) parts.push(`${failed} 个失败`)
  if (files) parts.push(`编辑了 ${files} 个文件`)
  if (thoughts && parts.length === 0) parts.push(`思考了 ${thoughts} 次`)
  if (others) parts.push(`${others} 个其他步骤`)
  return parts.join(' · ') || `${items.length} 个步骤`
}
