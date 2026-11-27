// PTY 后端接口：manager 只依赖这里的抽象，POSIX（python3 / script）与 Windows ConPTY（T31）各自实现。
import type { TermBackend, TermBackendPreference } from './types'

export interface PtySpawnOptions {
  shell: string
  args: string[]
  /** 绝对路径，调用方已确认存在 */
  cwd: string
  cols: number
  rows: number
  /** 完整环境（已含 TERM/COLUMNS/LINES） */
  env: Record<string, string>
}

export interface PtyExit {
  code: number | null
  /** 信号名；后端拿到编号时自行换成名字 */
  signal: string | null
}

/** 一个运行中的 PTY 会话。所有回调最多各登记一次（manager 负责分发）。 */
export interface PtyProcess {
  readonly backend: TermBackend
  readonly supportsResize: boolean
  /** shell 进程 pid（拿不到时为 null） */
  readonly pid: number | null
  onData(listener: (chunk: Buffer) => void): void
  /** 只触发一次；之后不再有 onData */
  onExit(listener: (exit: PtyExit) => void): void
  write(data: Buffer): void
  /** 已提交但尚未被 PTY 宿主读走的字节数，用于背压判断 */
  pendingWriteBytes(): number
  /** 返回 false 表示后端不支持运行时改尺寸 */
  resize(cols: number, rows: number): boolean
  /** 结束会话（含进程组），幂等 */
  kill(): void
}

export interface PtyBackendImpl {
  readonly name: TermBackend
  readonly supportsResize: boolean
  /** 进程就绪后 resolve；启动失败 reject（message 不得含终端输出） */
  spawn(options: PtySpawnOptions): Promise<PtyProcess>
}

/** 按偏好挑选后端；无可用后端时抛 WorkspaceError('pty_unavailable')。 */
export type PtyBackendResolver = (preference: TermBackendPreference) => Promise<PtyBackendImpl>
