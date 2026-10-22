/**
 * xterm 写入流控：已提交但尚未解析完的字节超过高水位时请求暂停 PTY 读取，
 * 回落到低水位后恢复。这样大输出时 xterm 的积压有上限，按键回显不会排在
 * 几 MB 输出之后（Ctrl+C 依然及时）。
 */
export const TERMINAL_WRITE_HIGH_WATERMARK = 256 * 1024
export const TERMINAL_WRITE_LOW_WATERMARK = 32 * 1024

export class TerminalWriteFlow {
  private pendingBytes = 0
  private paused = false

  constructor(private readonly onPauseChange: (paused: boolean) => void) {}

  /** 调用 term.write 之前记录本次提交的字节数。 */
  written(bytes: number) {
    this.pendingBytes += bytes
    if (!this.paused && this.pendingBytes >= TERMINAL_WRITE_HIGH_WATERMARK) {
      this.paused = true
      this.onPauseChange(true)
    }
  }

  /** term.write 回调（xterm 已解析完该块）时调用。 */
  parsed(bytes: number) {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes)
    if (this.paused && this.pendingBytes <= TERMINAL_WRITE_LOW_WATERMARK) {
      this.paused = false
      this.onPauseChange(false)
    }
  }

  /** 视图卸载时必须释放暂停，否则 PTY 会一直停读。 */
  dispose() {
    this.pendingBytes = 0
    if (!this.paused) return
    this.paused = false
    this.onPauseChange(false)
  }
}
