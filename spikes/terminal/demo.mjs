// @ts-nocheck
/** 交互式原型：在 93 上 `ssh -t root@192.168.10.93 "cd <dir> && node demo.mjs"` 运行。 */
// 一次性演示脚本，TTY/信号相关的动态分支不做类型标注。
import { spawnPty } from './pty.mjs'
import { detectCapabilities } from './probe.mjs'

const args = parseArgs(process.argv.slice(2))
const caps = await detectCapabilities()
const diag = (line) => process.stderr.write(`[spike] ${line}\n`)

diag(`python3: ${caps.pythonVersion || '不可用'} / script: ${caps.scriptVersion.replace(/\n/g, ' ') || '不可用'}`)

const pty = spawnPty({
  shell: args.shell ?? process.env.SHELL ?? '/bin/bash',
  cols: Number(args.cols ?? 80),
  rows: Number(args.rows ?? 24),
  cwd: args.cwd ?? process.cwd(),
  backend: args.backend ?? 'auto',
  capabilities: caps,
})
diag(`后端: ${pty.backend}（resize ${pty.supportsResize ? '支持' : '不支持'}）, pid=${pty.pid}`)

const stdinIsTty = process.stdin.isTTY === true
if (stdinIsTty && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true)
  process.stdin.resume()
}
const restore = () => {
  if (stdinIsTty && typeof process.stdin.setRawMode === 'function') {
    try {
      process.stdin.setRawMode(false)
    } catch {
      // 已经脱离 TTY。
    }
  }
}

let bytesIn = 0
let bytesOut = 0
let lastSize = { cols: Number(args.cols ?? 80), rows: Number(args.rows ?? 24) }

pty.onData((chunk) => {
  bytesOut += chunk.byteLength
  process.stdout.write(chunk)
})
pty.onStderr((chunk) => diag(`桥 stderr: ${chunk.toString('utf8').trim()}`))
pty.onExit((info) => {
  restore()
  diag(`退出: code=${info.code} signal=${info.signal} source=${info.source}`)
  diag(`流量: 输入 ${bytesIn} B / 输出 ${bytesOut} B`)
  process.exitCode = 0
})

if (stdinIsTty && typeof process.stdout.getWindowSize === 'function') {
  // tty.WriteStream#getWindowSize() 返回 [columns, rows]。
  const applyTerminalSize = () => {
    const size = process.stdout.getWindowSize() ?? [80, 24]
    lastSize = { cols: size[0], rows: size[1] }
    pty.resize(lastSize.cols, lastSize.rows)
    return lastSize
  }
  applyTerminalSize()
  process.stdout.on('resize', () => {
    const size = applyTerminalSize()
    diag(`窗口变化: ${size.cols}x${size.rows}`)
  })
}

process.stdin.on('data', (chunk) => {
  bytesIn += chunk.byteLength
  pty.write(chunk)
})
process.stdin.on('end', () => diag('stdin EOF：终端仍保持运行，可用 Ctrl+D / exit 结束'))

process.on('SIGINT', () => pty.write('\u0003'))
process.on('SIGTERM', () => pty.kill())
process.on('exit', restore)

await pty.waitReady()
pty.write(
  `printf '\\033[1;36mQingCode Next 终端原型\\033[0m  backend=%s size=%sx%s\\n' '${pty.backend}' '${lastSize.cols}' '${lastSize.rows}'\n`,
)
diag('已就绪。试试 `vim`/`vi`、`less`、`top`、中文输入、Ctrl+C；`exit` 退出。')

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const item of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(item)
    if (match) out[match[1]] = match[2]
  }
  return out
}
