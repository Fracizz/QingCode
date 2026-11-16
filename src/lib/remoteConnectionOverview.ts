import type { Project, SshConnection } from '../types'
import { sshConnectionIdFromUri } from './sshWorkspace'
import { sshServerVersionMismatch, type SshServerState } from './sshServerStatus'

export function groupConnectionProjects(projects: Project[]): Map<string, Project[]> {
  const groups = new Map<string, Project[]>()
  for (const project of projects) {
    const id = project.connection_id ?? sshConnectionIdFromUri(project.path)
    if (!id) continue
    const group = groups.get(id) ?? []
    group.push(project)
    groups.set(id, group)
  }
  for (const group of groups.values()) group.sort((a, b) => b.last_opened_at - a.last_opened_at || a.name.localeCompare(b.name))
  return groups
}

export function matchesConnection(connection: SshConnection, projects: Project[], query: string): boolean {
  const haystack = [connection.name, connection.host, connection.port, connection.username,
    connection.agentEndpoint?.host, connection.agentEndpoint?.port,
    ...projects.flatMap(project => [project.name, project.root_path, project.path])].join(' ').toLocaleLowerCase()
  return query.trim().toLocaleLowerCase().split(/\s+/).every(term => haystack.includes(term))
}

export function connectionStatus(alive: boolean | null | undefined, states: SshServerState[], error?: string) {
  if (error) return { label: '检查失败', tone: 'warn', attention: true } as const
  if (alive === undefined) return { label: '正在检查…', tone: 'muted', attention: false } as const
  if (alive === null) return { label: '尚未检查', tone: 'muted', attention: false } as const
  if (!alive) return { label: '未连接', tone: 'muted', attention: states.some(state => !!state.reason) } as const
  const active = states.filter(state => state.phase !== 'disconnected')
  if (states.some(state => sshServerVersionMismatch(state.reason)) || states.some(state => !!state.reason && state.phase !== 'readyServer' && state.phase !== 'readyDirect')) {
    return { label: '服务需要处理', tone: 'warn', attention: true } as const
  }
  if (active.some(state => !['readyServer', 'readyDirect'].includes(state.phase))) {
    return { label: '正在准备服务', tone: 'muted', attention: false } as const
  }
  if (active.some(state => state.phase === 'readyServer')) return { label: '服务已就绪', tone: 'ok', attention: false } as const
  return { label: '已连接', tone: 'ok', attention: false } as const
}

/** 旧 daemon 被替换或退出后残留的原始通道错误：用户看不懂，也不知道下一步做什么。 */
export function isDaemonChannelClosed(reason: string | null | undefined): boolean {
  return /^daemon 连接(?:已关闭|代理已退出)/.test((reason ?? '').trim())
}

/** 强制更新进行中的展示步骤（1–4），跟随该根实时推送的阶段。 */
export function forceUpdateStep(phase: SshServerState['phase'] | undefined): { step: number; label: string } {
  if (phase === 'installing') return { step: 2, label: '正在安装新版远端服务…' }
  if (phase === 'handshaking') return { step: 3, label: '正在连接新版远端服务…' }
  return { step: 1, label: '正在结束旧服务并准备更新…' }
}
