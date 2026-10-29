import { create } from 'zustand'
import type { Project } from '../types'
import type { SshServerState } from '../lib/sshServerStatus'
import { translate } from '../lib/i18n'

export type SshOpeningStage = 'connecting' | 'service' | 'files' | 'mounting'

interface SshOpeningAttempt {
  id: number
  project: Project
  stage: SshOpeningStage
  server: SshServerState | null
  error: string | null
  controller: AbortController
  reusingServer: boolean
}

export const useSshOpeningStore = create<{ attempt: SshOpeningAttempt | null }>(() => ({
  attempt: null,
}))

export class SshPreparationError extends Error {}
let openingSequence = 0

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
  const attempt: SshOpeningAttempt = {
    id: ++openingSequence, project, stage: 'connecting', server: null, error: null, controller, reusingServer: false,
  }
  useSshOpeningStore.setState({ attempt })
  const report = (stage: SshOpeningStage, server?: SshServerState) => {
    if (signal.aborted || useSshOpeningStore.getState().attempt?.controller !== controller) return
    useSshOpeningStore.setState(state => ({
      attempt: state.attempt && {
        ...state.attempt, stage, server: server ?? state.attempt.server,
        reusingServer: server?.phase === 'installing' ? false : stage === 'mounting' || state.attempt.reusingServer,
      },
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
    if (useSshOpeningStore.getState().attempt?.controller === controller) {
      useSshOpeningStore.setState({ attempt: null })
    }
    return result
  } catch (error) {
    if (useSshOpeningStore.getState().attempt?.controller === controller) {
      if (error instanceof SshPreparationError) {
        useSshOpeningStore.setState(state => ({
          attempt: state.attempt && { ...state.attempt, error: error.message },
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
