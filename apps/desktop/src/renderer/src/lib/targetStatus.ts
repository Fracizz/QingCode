import type { TargetState } from '../../../shared/backendApi'

// 目标连接状态的展示语义：侧栏切换器、标题栏面包屑、状态栏共用，保证颜色与文案一致。

export const targetDotClass: Record<TargetState, string> = {
  idle: 'bg-qn-dim',
  connecting: 'bg-qn-warn animate-pulse',
  deploying: 'bg-qn-warn animate-pulse',
  ready: 'bg-qn-ok',
  error: 'bg-qn-danger',
}

export const targetStateLabel: Record<TargetState, string> = {
  idle: '未连接',
  connecting: '连接中',
  deploying: '部署中',
  ready: '已就绪',
  error: '连接失败',
}

export function isTargetBusy(state: TargetState): boolean {
  return state === 'connecting' || state === 'deploying'
}

export function isTargetActive(state: TargetState): boolean {
  return state === 'ready' || isTargetBusy(state)
}

/** 目标切换器的搜索：名称、主机、用户名任一包含关键字即可，忽略大小写。 */
export function matchTarget(
  target: { name: string; kind: string; host?: string; username?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [target.name, target.host ?? '', target.username ?? '']
    .some((field) => field.toLowerCase().includes(q))
}
