import fs from 'node:fs'

const LOG_MAX_BYTES = 5 * 1024 * 1024

/** 只写固定描述与脱敏后的 codex stderr；token、密码、密钥不进日志。 */
export function redact(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/"(?:token|password|passphrase|apiKey)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
}

export class Logger {
  private readonly rotationFile: string

  constructor(
    private readonly file: string,
    private readonly maxBytes = LOG_MAX_BYTES,
  ) {
    this.rotationFile = `${file}.1`
  }

  info(message: string): void {
    this.write('INFO', message)
  }

  warn(message: string): void {
    this.write('WARN', message)
  }

  private write(level: string, message: string): void {
    try {
      this.rotate()
      const line = `${new Date().toISOString()} [${process.pid}] ${level} ${redact(message)}\n`
      fs.appendFileSync(this.file, line, 'utf8')
    } catch {
      // 日志失败不能让 daemon 退出；stderr 已被 detach 的 daemon 丢弃，只能忽略。
    }
  }

  private rotate(): void {
    let size: number
    try {
      size = fs.statSync(this.file).size
    } catch {
      return
    }
    if (size <= this.maxBytes) return
    try {
      fs.rmSync(this.rotationFile, { force: true })
      fs.renameSync(this.file, this.rotationFile)
    } catch {
      // 保留 1 份即可，滚动失败继续追加。
    }
  }
}
