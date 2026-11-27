/**
 * 异步读取 Agent CLI 的 --version：替代 spawnSync，避免探测期间阻塞 daemon 事件循环
 * （同一 daemon 上其他 Agent 的流式消息、手机端请求都会被卡住）。
 * 输出只用于提取版本号，stderr 丢弃不进日志（可能含用户环境信息）。
 */
import { spawn } from 'node:child_process'

export interface VersionCommand {
  command: string
  args?: string[]
  shell?: boolean
}

const DEFAULT_TIMEOUT_MS = 3_000
// 版本输出很短，超过上限说明不是预期程序，截断避免占用内存。
const MAX_OUTPUT = 4096

export function readVersionAsync(spec: VersionCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.command, [...(spec.args ?? []), '--version'], {
        windowsHide: true,
        shell: spec.shell ?? false,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve('unknown')
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      done(parseVersion(stdout))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk
    })
    child.on('error', () => done('unknown'))
    child.on('close', () => done(parseVersion(stdout)))
  })
}

export function parseVersion(text: string): string {
  return text.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown'
}
