import { isTauri, safeInvoke } from './tauri'
import type { WarmupPhase } from './sshWarmupQueue'

export interface SshOpenDiagnostic {
  projectId: string
  connectionId?: string
  /** 点击时的预热状态；none 表示队列里没有这个项目。 */
  warmup: WarmupPhase | 'none'
  warmupDetail?: string
  /** 是否直接复用了后台准备结果。 */
  reused: boolean
  outcome: 'opened' | 'failed' | 'cancelled'
  warmupMs: number
  connectMs: number
  prepareMs: number
  filesMs: number
}

/** 写入本机生命周期日志，只含固定字段，失败不影响打开流程。 */
export function recordSshOpenDiagnostic(event: SshOpenDiagnostic): void {
  if (!isTauri()) return
  void safeInvoke('记录远程项目打开诊断', 'ssh_open_diagnostic_event', { event })
    .catch(error => console.warn('ssh open diagnostic unavailable', error))
}
