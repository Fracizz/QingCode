// @ts-nocheck
/** 最小冒烟：验证 python3 桥的 stdout/stdin/控制通道/退出码是否都通。 */
import { spawnPty } from './pty.mjs'
import { detectCapabilities } from './probe.mjs'

const backend = process.argv[2] === 'script' ? 'script' : 'python'
const caps = await detectCapabilities()
const pty = spawnPty({
  shell: '/bin/bash',
  args: ['--noprofile', '--norc', '-i'],
  cols: 80,
  rows: 24,
  backend,
  capabilities: caps,
})
let text = ''
let bytes = 0
let exit = null
pty.onData((chunk) => {
  bytes += chunk.byteLength
  text = (text + chunk.toString('utf8')).slice(-8192)
})
pty.onStderr((chunk) => process.stderr.write(`[bridge] ${chunk.toString('utf8')}`))
pty.onExit((info) => {
  exit = info
})

const waitFor = async (predicate, timeoutMs, label) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`超时: ${label}; 尾部输出=${JSON.stringify(text.slice(-500))}`)
}

const ready = await pty.waitReady(8000)
pty.write(`printf 'QN_SMOKE_%s\\n' "$((40+2))"\n`)
await waitFor(() => text.includes('QN_SMOKE_42'), 5000, 'shell 输出')
const resized = pty.resize(120, 40)
pty.write(`printf 'QN_SIZE_%s\\n' "$(stty size | tr ' ' x)"\n`)
const expectedSize = backend === 'python' ? 'QN_SIZE_40x120' : 'QN_SIZE_24x80'
await waitFor(() => text.includes(expectedSize), 5000, `窗口尺寸 ${expectedSize}`)
pty.write('exit 5\n')
await waitFor(() => exit !== null, 5000, '退出事件')
process.stdout.write(
  `${JSON.stringify({ caps, ready, backend: pty.backend, bytes, resized, exit, ok: exit?.code === 5 }, null, 2)}\n`,
)
pty.kill()
