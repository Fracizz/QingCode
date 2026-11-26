// @ts-nocheck
/** 一次性诊断脚本：看 initShell 之后后续命令到底有没有被 shell 执行。 */
import { spawnPty } from './pty.mjs'
import { detectCapabilities } from './probe.mjs'

const caps = await detectCapabilities()
const backend = process.argv[2] === 'script' ? 'script' : 'python'
const token = 'tok123'
const pty = spawnPty({
  shell: '/bin/bash',
  args: ['--noprofile', '--norc', '-i'],
  cols: 80,
  rows: 24,
  cwd: '/tmp',
  env: { QN_TOKEN: token, PS1: '' },
  backend,
  capabilities: caps,
})
let text = ''
let exited = null
pty.onData((chunk) => {
  text = (text + chunk.toString('utf8')).slice(-4000)
})
pty.onStderr((chunk) => process.stderr.write(`[bridge] ${chunk.toString('utf8')}`))
pty.onExit((info) => {
  exited = info
  process.stdout.write(`[exit] ${JSON.stringify(info)}\n`)
})
await pty.waitReady(8000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const steps = [
  `stty -echo 2>/dev/null; printf '\\nQN_INIT_%s\\n' "$QN_TOKEN"\n`,
  `printf 'QN_SECOND_%s\\n' "$QN_TOKEN"\n`,
  `printf 'QN_THIRD_%s_%s\\n' '中文测试' "$QN_TOKEN"\n`,
  `stty size\n`,
]
for (const step of steps) {
  pty.write(step)
  await sleep(900)
  process.stdout.write(`--- ${JSON.stringify(step)} ---\n${JSON.stringify(text.slice(-700))}\n`)
}
const sleepCmd = `printf 'QN_SLEEP_%s\\n' "$QN_TOKEN"; sleep 30; printf 'QN_NOINT_%s\\n' "$QN_TOKEN"\n`
pty.write(sleepCmd)
await sleep(500)
process.stdout.write(`--- sleep ---\n${JSON.stringify(text.slice(-400))}\n`)
pty.write('\u0003')
await sleep(500)
process.stdout.write(`--- ctrl-c ---\n${JSON.stringify(text.slice(-400))}\nexited=${JSON.stringify(exited)}\n`)
pty.write(`printf 'QN_AFTER_%s\\n' "$QN_TOKEN"\n`)
await sleep(700)
process.stdout.write(`--- after ---\n${JSON.stringify(text.slice(-400))}\nexited=${JSON.stringify(exited)}\n`)
pty.write('exit 0\n')
await sleep(500)
pty.kill()
