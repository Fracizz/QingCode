import net from 'node:net'
import { resolvePaths } from './paths'

export interface ConnectOptions {
  stateDir?: string
}

/**
 * 纯字节桥接：stdin/stdout 与 daemon 本地 IPC 双向对接，不解析帧、不持有 token。
 * 任一端 EOF 即结束；错误只写 stderr，避免污染 stdout 上的协议帧。
 */
export function runConnect(options: ConnectOptions): Promise<void> {
  const paths = resolvePaths(options.stateDir)
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: paths.endpoint })
    let done = false

    const finish = (err?: Error): void => {
      if (done) return
      done = true
      if (err) {
        process.stderr.write(`qn-server connect: ${err.message}\n`)
        process.exitCode = 1
      }
      try {
        socket.destroy()
      } catch {
        // 已断开。
      }
      try {
        process.stdin.destroy()
      } catch {
        // 已断开。
      }
      // stdin 的句柄可能仍被事件循环引用，兜底退出而不截断已写入 stdout 的帧。
      const code = typeof process.exitCode === 'number' ? process.exitCode : 0
      const timer = setTimeout(() => process.exit(code), 250)
      timer.unref()
      resolve()
    }

    socket.once('connect', () => {
      process.stdin.pipe(socket, { end: false })
      socket.pipe(process.stdout, { end: false })
    })
    socket.once('error', (err: Error) => finish(err))
    socket.once('end', () => process.stdout.end())
    socket.once('close', () => finish())
    process.stdin.once('error', () => finish())
    process.stdin.once('end', () => socket.end())
    process.stdout.once('error', () => finish(new Error('stdout 写入失败')))
  })
}
