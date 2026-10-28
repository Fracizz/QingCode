import { create } from 'zustand'
import type { Project } from '../types'
import type { SshServerState } from '../lib/sshServerStatus'
import { translate } from '../lib/i18n'

export type SshOpeningStage = 'connecting' | 'service' | 'files' | 'mounting'
export type SshOpeningTimedStage = Exclude<SshOpeningStage, 'mounting'>

export function sshOpeningTimedStage(stage: SshOpeningStage): SshOpeningTimedStage {
  return stage === 'mounting' ? 'service' : stage
}

interface SshOpeningAttempt {
  project: Project
  stage: SshOpeningStage
  server: SshServerState | null
  error: string | null
  controller: AbortController
  reusingServer: boolean
  background: boolean
  startedAt: number
  stageStartedAt: number
  stageDurations: Partial<Record<SshOpeningTimedStage, number>>
  finishedAt: number | null
}

export const useSshOpeningStore = create<{ attempt: SshOpeningAttempt | null }>(() => ({
  attempt: null,
}))

export class SshPreparationError extends Error {}

export function setSshOpeningBackground(background: boolean): void {
  useSshOpeningStore.setState(state => ({
    attempt: state.attempt && { ...state.attempt, background, reusingServer: background && state.attempt.reusingServer },
  }))
}

export function cancelSshOpening(): void {
  const attempt = useSshOpeningStore.getState().attempt
  attempt?.controller.abort(new DOMException('Cancelled', 'AbortError'))
  useSshOpeningStore.setState({ attempt: null })
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
  cancelSshOpening()
  const controller = new AbortController()
  const { signal } = controller
  const startedAt = Date.now()
  const attempt: SshOpeningAttempt = {
    project, stage: 'connecting', server: null, error: null, controller, reusingServer: false,
    background: false, startedAt, stageStartedAt: startedAt, stageDurations: {}, finishedAt: null,
  }
  useSshOpeningStore.setState({ attempt })
  const report = (stage: SshOpeningStage, server?: SshServerState) => {
    if (signal.aborted || useSshOpeningStore.getState().attempt?.controller !== controller) return
    useSshOpeningStore.setState(state => {
      if (!state.attempt || state.attempt.finishedAt != null) return state
      const previous = state.attempt
      const previousStage = sshOpeningTimedStage(previous.stage)
      const changed = previousStage !== sshOpeningTimedStage(stage)
      const now = Date.now()
      return { attempt: {
        ...previous, stage, server: server ?? previous.server,
        stageStartedAt: changed ? now : previous.stageStartedAt,
        stageDurations: changed ? {
          ...previous.stageDurations,
          [previousStage]: (previous.stageDurations[previousStage] ?? 0) + now - previous.stageStartedAt,
        } : previous.stageDurations,
        reusingServer: server?.phase === 'installing' ? false : stage === 'mounting' || previous.reusingServer,
      } }
    })
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
    if (useSshOpeningStore.getState().attempt?.controller === controller) {
      useSshOpeningStore.setState({ attempt: null })
    }
    return result
  } catch (error) {
    if (useSshOpeningStore.getState().attempt?.controller === controller) {
      if (error instanceof SshPreparationError) {
        useSshOpeningStore.setState(state => ({
          attempt: state.attempt && { ...state.attempt, error: error.message, finishedAt: Date.now() },
        }))
      } else {
        useSshOpeningStore.setState({ attempt: null })
      }
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
