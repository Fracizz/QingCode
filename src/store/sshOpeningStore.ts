import { create } from 'zustand'
import type { Project } from '../types'
import type { SshServerState } from '../lib/sshServerStatus'
import { translate } from '../lib/i18n'

export type SshOpeningStage = 'connecting' | 'service' | 'files' | 'mounting'

export interface SshOpeningAttempt {
  id: number
  /** 所属连接的分组键，见 sshOpeningKey。 */
  key: string
  startedAt: number
  project: Project
  stage: SshOpeningStage
  server: SshServerState | null
  error: string | null
  controller: AbortController
  reusingServer: boolean
  /** 用户点了“后台运行”：隐藏进度卡，打开流程继续；出错时仍会弹出错误框。 */
  background: boolean
}

/**
 * 打开流程按 SSH 连接分开：不同连接（WinDev、WSL、Linux…）的打开/安装/更新
 * 可以同时进行、互不取消；同一连接上新的打开会取代旧的（服务任务本身共享）。
 */
export const useSshOpeningStore = create<{ attempts: Record<string, SshOpeningAttempt> }>(() => ({
  attempts: {},
}))

export class SshPreparationError extends Error {}
let openingSequence = 0

/** 打开任务的分组键：项目所属 SSH 连接；没有连接信息时退回项目路径。 */
export function sshOpeningKey(project: Pick<Project, 'connection_id' | 'path'>): string {
  return project.connection_id || project.path.match(/^ssh:\/\/([^/]+)/)?.[1] || project.path
}

/** 按项目查找它所在连接上的打开任务，且该任务确实在打开这个项目。 */
export function sshOpeningForPath(
  attempts: Record<string, SshOpeningAttempt>,
  path: string,
): SshOpeningAttempt | undefined {
  return Object.values(attempts).find(attempt => attempt.project.path === path)
}

/** 最近发起的打开任务（没有则为 null）。 */
export function latestSshOpening(): SshOpeningAttempt | null {
  const list = Object.values(useSshOpeningStore.getState().attempts)
  return list.reduce<SshOpeningAttempt | null>((latest, item) => (!latest || item.id > latest.id ? item : latest), null)
}

function removeAttempt(key: string, controller?: AbortController) {
  useSshOpeningStore.setState(state => {
    const current = state.attempts[key]
    if (!current || (controller && current.controller !== controller)) return state
    const attempts = { ...state.attempts }
    delete attempts[key]
    return { attempts }
  })
}

function patchAttempt(
  key: string,
  controller: AbortController,
  patch: (attempt: SshOpeningAttempt) => Partial<SshOpeningAttempt>,
) {
  useSshOpeningStore.setState(state => {
    const current = state.attempts[key]
    if (!current || current.controller !== controller) return state
    return { attempts: { ...state.attempts, [key]: { ...current, ...patch(current) } } }
  })
}

/** 取消指定连接的打开流程；不传则取消全部（测试与整体重置用）。 */
export function cancelSshOpening(key?: string): void {
  const { attempts } = useSshOpeningStore.getState()
  const keys = key === undefined ? Object.keys(attempts) : [key]
  for (const item of keys) {
    const attempt = attempts[item]
    if (!attempt) continue
    attempt.controller.abort(new DOMException('Cancelled', 'AbortError'))
    removeAttempt(item, attempt.controller)
  }
}

/** 切到后台运行 / 重新展开进度卡，不影响打开流程本身。 */
export function setSshOpeningBackground(key: string, background: boolean): void {
  useSshOpeningStore.setState(state => {
    const attempt = state.attempts[key]
    return attempt && attempt.background !== background
      ? { attempts: { ...state.attempts, [key]: { ...attempt, background } } }
      : state
  })
}

/** Cancel opening, not the shared SSH session or a deployment used by other roots. */
export async function runSshOpening<T>(
  project: Project,
  work: (
    signal: AbortSignal,
    report: (stage: SshOpeningStage, server?: SshServerState) => void
  ) => Promise<T>,
  timeoutMs = 180_000
): Promise<T> {
  const key = sshOpeningKey(project)
  cancelSshOpening(key)
  const controller = new AbortController()
  const { signal } = controller
  const attempt: SshOpeningAttempt = {
    id: ++openingSequence, key, startedAt: Date.now(), project, stage: 'connecting', server: null, error: null, controller, reusingServer: false, background: false,
  }
  useSshOpeningStore.setState(state => ({ attempts: { ...state.attempts, [key]: attempt } }))
  const isCurrent = () => useSshOpeningStore.getState().attempts[key]?.controller === controller
  const report = (stage: SshOpeningStage, server?: SshServerState) => {
    if (signal.aborted) return
    patchAttempt(key, controller, current => ({
      stage, server: server ?? current.server,
      reusingServer: server?.phase === 'installing' ? false : stage === 'mounting' || current.reusingServer,
    }))
  }
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(() => controller.abort(new SshPreparationError(
    translate('打开远程项目超时，请检查连接或远端服务后重试。')
  )), timeoutMs)
  try {
    const result = await Promise.race([work(signal, report), aborted])
    signal.throwIfAborted()
    removeAttempt(key, controller)
    return result
  } catch (error) {
    if (isCurrent()) {
      if (error instanceof SshPreparationError) {
        patchAttempt(key, controller, () => ({ error: error.message }))
      } else {
        removeAttempt(key, controller)
      }
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
