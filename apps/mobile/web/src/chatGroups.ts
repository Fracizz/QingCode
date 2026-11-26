import type { ItemView } from '@qn/codex-client'

/** 子代理单独显示，便于从消息流直接查看。 */
export type ToolItem = Exclude<ItemView, { kind: 'user' | 'agent' | 'reasoning' | 'subagent' }>

export type ChatBlock =
  | { kind: 'item'; item: ItemView }
  | { kind: 'tools'; id: string; items: ToolItem[] }

export type ToolStatus = 'running' | 'failed' | 'done'

const isTool = (item: ItemView): item is ToolItem =>
  item.kind === 'command' || item.kind === 'fileChange' || (item.kind === 'other' && item.type !== 'contextCompaction')

export function toolStatus(item: ToolItem): ToolStatus {
  const status = 'status' in item && typeof item.status === 'string' ? item.status : ''
  if (/progress|running|started/i.test(status)) return 'running'
  if (/fail|error|denied|declined/i.test(status)) return 'failed'
  if (item.kind === 'command' && typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed'
  return 'done'
}

/**
 * 连续 2 个及以上工具步骤折叠成一行摘要（参考电脑版与 Orca），单个步骤原样显示；
 * 手机屏幕上一长串命令卡片会把真正的回复挤出视野。
 */
export function groupChatItems(items: readonly ItemView[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length >= 2) blocks.push({ kind: 'tools', id: `tools:${run[0]!.id}`, items: run })
    else for (const item of run) blocks.push({ kind: 'item', item })
    run = []
  }
  for (const item of items) {
    if (isTool(item)) {
      run.push(item)
      continue
    }
    flush()
    blocks.push({ kind: 'item', item })
  }
  flush()
  return blocks
}

/** 摘要文案：「已运行 3 条命令 · 改动 2 个文件 · 1 个失败」，仍在运行时改为进行时。 */
export function toolSummary(items: readonly ToolItem[]): string {
  const commands = items.filter((item) => item.kind === 'command').length
  const files = items
    .filter((item) => item.kind === 'fileChange')
    .reduce((total, item) => total + (item.kind === 'fileChange' ? Math.max(1, item.changes.length) : 0), 0)
  const others = items.length - commands - items.filter((item) => item.kind === 'fileChange').length
  const failed = items.filter((item) => toolStatus(item) === 'failed').length
  const running = items.some((item) => toolStatus(item) === 'running')
  const parts: string[] = []
  if (commands) parts.push(`${running ? '正在运行' : '已运行'} ${commands} 条命令`)
  if (files) parts.push(`改动 ${files} 个文件`)
  if (others) parts.push(`${others} 个其它步骤`)
  if (failed) parts.push(`${failed} 个失败`)
  return parts.join(' · ') || `${items.length} 个步骤`
}
