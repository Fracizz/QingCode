import { win32, posix } from 'node:path'
import { isAgentKind, type ScheduleRuntime } from '@qn/protocol'
import type { Project } from '../shared/backendApi'
import { backendConfig } from './config'
import { readProjects, writeProjects } from './projectStore'
import { RouterError, type BackendRouter } from './router'
import { readAppSettings } from './settings/settingsStore'

let tail: Promise<unknown> = Promise.resolve()

// 创建任务与撤销项目信任必须有确定顺序，避免暂停后另一个请求又启用了同一项目。
export function withProjectMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const next = tail.then(mutation)
  tail = next.catch(() => undefined)
  return next
}

function projectPathKey(value: string): string {
  const native = /^\/[a-z]:[\\/]/i.test(value) ? value.slice(1) : value
  if (/^[a-z]:(?:[\\/]|$)|^\\\\/i.test(native)) {
    return win32.normalize(/^[a-z]:$/i.test(native) ? native + '\\' : native).replace(/[\\/]+$/, '').toLowerCase()
  }
  return posix.normalize(value).replace(/\/+$/, '')
}

export async function pauseProjectSchedules(router: BackendRouter, project: Project): Promise<void> {
  try {
    await router.invoke('server.req', {
      targetId: project.targetId, method: 'schedule.pauseProject', params: { cwd: project.path },
    })
  } catch (error) {
    if (error instanceof RouterError) {
      if (error.code === 'method') return
      if (error.code === 'not_connected') {
        if (!project.hasSchedules) return
        throw new RouterError('not_connected', '目标未连接。请连接后再更改项目信任或移除项目，以便停用远端定时任务。')
      }
    }
    throw error
  }
}

export async function scheduleProjectMutation(
  targetId: string, method: string, params: Record<string, unknown>, forward: (params: unknown) => Promise<unknown>,
): Promise<unknown> {
  return withProjectMutation(async () => {
    const cwd = params.cwd
    if (typeof cwd !== 'string' || !cwd.trim()) throw new RouterError('invalid_params', '定时任务需要项目路径')
    const projects = await readProjects(backendConfig.userData)
    const project = projects.find((item) => item.targetId === targetId && projectPathKey(item.path) === projectPathKey(cwd))
    if (!project?.trusted) throw new RouterError('forbidden', '仅受信任的项目可以保存或运行定时任务')
    if (method !== 'schedule.upsert') return forward(params)
    if (!isAgentKind(params.agent)) throw new RouterError('invalid_params', '请选择定时任务的 Agent')
    const settings = await readAppSettings(backendConfig.userData)
    const prefs = settings.agents[targetId]?.[params.agent]
    if (prefs?.enabled === false) throw new RouterError('forbidden', '目标中的 Agent 已停用')
    const runtime: ScheduleRuntime = params.agent === 'codex' ? { codexPath: prefs?.path, codexHome: prefs?.configDir }
      : params.agent === 'claude' ? { claudePath: prefs?.path, claudeConfigDir: prefs?.configDir } : { piPath: prefs?.path }
    // 先记录项目可能有定时任务。即使连接在写入远端后断开，离线时也不会误报已停用。
    if (!project.hasSchedules) {
      await writeProjects(backendConfig.userData, projects.map((item) =>
        item.id === project.id ? { ...item, hasSchedules: true } : item))
    }
    return forward({ ...params, runtime })
  })
}
