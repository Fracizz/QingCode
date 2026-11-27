/**
 * Claude 桥真机验收脚本（在装有并已登录 Claude Code 的目标机上跑）。
 *
 * 用法：
 *   node packages/server/test/claude-probe.mjs <qn-server.cjs 路径> [cwd] [选项]
 * 选项：
 *   --claude-path P   显式指定 claude 可执行文件
 *   --state-dir D     复用某个已运行的 daemon（不会在结束时关闭它）
 *   --timeout MS      单轮等待上限（默认 180000）
 *
 * 流程：ensure → connect → codex.open{agent:'claude'} → attach → thread/start →
 * turn/start「只回复两个字：你好」→ 打印通知统计 → 再发一轮「用 Bash 运行 echo qn-ok」
 * 并自动 accept 审批 → 打印结果。不打印任何 token / 凭据内容。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , ...argv] = process.argv
const positional = argv.filter((arg) => !arg.startsWith('--'))
const bundle = positional[0] ? path.resolve(positional[0]) : ''
const cwd = positional[1] ? path.resolve(positional[1]) : process.cwd()

function option(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const claudePath = option('--claude-path', undefined)
const explicitStateDir = option('--state-dir', undefined)
const turnTimeout = Number(option('--timeout', '180000')) || 180_000

if (!bundle) {
  process.stderr.write(
    '用法: node claude-probe.mjs <qn-server.cjs> [cwd] [--claude-path P] [--state-dir D] [--timeout MS]\n',
  )
  process.exit(2)
}

const tempRoot = explicitStateDir ? null : mkdtempSync(path.join(tmpdir(), 'qn-claude-probe-'))
const stateDir = explicitStateDir ? path.resolve(explicitStateDir) : path.join(tempRoot, 'state')

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (this.buffer.length < 4 + length) break
      out.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return out
  }
}

const ensure = spawnSync(
  process.execPath,
  [bundle, 'ensure', '--state-dir', stateDir],
  { encoding: 'utf8', timeout: 30_000, windowsHide: true },
)
if (ensure.status !== 0) {
  throw new Error(`ensure 失败 (${ensure.status}): ${ensure.stderr || ensure.stdout}`)
}
const { token } = JSON.parse(ensure.stdout.trim())

const child = spawn(
  process.execPath,
  [bundle, 'connect', '--stdio', '--state-dir', stateDir],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
)
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

const decoder = new FrameDecoder()
const frames = []
let autoApprove = false
const autoApproved = new Set()

child.stdout.on('data', (chunk) => {
  for (const frame of decoder.push(chunk)) {
    frames.push(frame)
    if (
      autoApprove &&
      frame.t === 'codex.recv' &&
      frame.agent === 'claude' &&
      String(frame.msg?.method ?? '').endsWith('requestApproval') &&
      frame.msg?.id !== undefined &&
      !autoApproved.has(frame.msg.id)
    ) {
      autoApproved.add(frame.msg.id)
      send({ t: 'codex.send', agent: 'claude', msg: { id: frame.msg.id, result: { decision: 'accept' } } })
      process.stdout.write(`自动批准审批: ${String(frame.msg.method)}\n`)
    }
  }
})

function send(frame) {
  child.stdin.write(encodeFrame(frame))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function wait(predicate, timeoutMs = turnTimeout, label = '消息') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = frames.find(predicate)
    if (found) return found
    await sleep(20)
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`)
}

let reqId = 0
async function req(method, params) {
  const id = ++reqId
  send({ t: 'req', id, method, ...(params !== undefined ? { params } : {}) })
  const res = await wait((f) => f.t === 'res' && f.id === id, 30_000, `${method} 响应`)
  if (res.ok !== true) throw new Error(`${method} 失败: ${JSON.stringify(res.error)}`)
  return res.result
}

function rpc(id, method, params) {
  send({ t: 'codex.send', agent: 'claude', msg: { id, method, ...(params !== undefined ? { params } : {}) } })
  return wait(
    (f) => f.t === 'codex.recv' && f.msg?.id === id,
    turnTimeout,
    `${method} 响应`,
  ).then((frame) => {
    if (frame.msg.error) throw new Error(`${method}: ${JSON.stringify(frame.msg.error)}`)
    return frame.msg.result
  })
}

function stats(fromIndex) {
  const counts = new Map()
  for (const frame of frames.slice(fromIndex)) {
    if (frame.t !== 'codex.recv' || frame.agent !== 'claude') continue
    const method = String(frame.msg?.method ?? (frame.msg?.id ? 'response' : 'unknown'))
    counts.set(method, (counts.get(method) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function collectText(fromIndex) {
  const parts = []
  for (const frame of frames.slice(fromIndex)) {
    if (frame.t !== 'codex.recv' || frame.agent !== 'claude') continue
    const msg = frame.msg ?? {}
    if (msg.method === 'item/agentMessage/delta') parts.push(String(msg.params?.delta ?? ''))
  }
  return parts.join('')
}

function commandOutputs(fromIndex) {
  const outputs = []
  for (const frame of frames.slice(fromIndex)) {
    if (frame.t !== 'codex.recv' || frame.agent !== 'claude') continue
    const item = frame.msg?.params?.item
    if (item?.type === 'commandExecution' && item.aggregatedOutput) {
      outputs.push({ command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode })
    }
  }
  return outputs
}

async function main() {
  send({ t: 'hello', protocol: 1, token, client: { name: 'claude-probe', version: '0.0.1' } })
  const welcome = await wait((f) => f.t === 'welcome' || f.t === 'error', 10_000, 'welcome')
  if (welcome.t !== 'welcome') throw new Error(`握手失败: ${JSON.stringify(welcome)}`)

  const opened = await req('codex.open', {
    agent: 'claude',
    ...(claudePath ? { claudePath } : {}),
  })
  process.stdout.write(`codex.open: ${JSON.stringify(opened)}\n`)
  await req('codex.attach', { agent: 'claude', sinceSeq: opened.lastSeq ?? 0 })

  const thread = await rpc('probe-thread', 'thread/start', { cwd })
  const threadId = thread?.thread?.id
  if (!threadId) throw new Error(`thread/start 没有返回 thread.id: ${JSON.stringify(thread)}`)
  process.stdout.write(`会话: ${threadId}\n`)

  const firstIndex = frames.length
  const firstTurn = await rpc('probe-turn-1', 'turn/start', {
    threadId,
    input: [{ type: 'text', text: '只回复两个字：你好', text_elements: [] }],
  })
  await wait(
    (f) => f.t === 'codex.recv' && f.agent === 'claude' && f.msg?.method === 'turn/completed',
    turnTimeout,
    '第一轮 turn/completed',
  )
  process.stdout.write(`第一轮 turn: ${JSON.stringify(firstTurn.turn?.id ?? '')}\n`)
  process.stdout.write('第一轮通知统计:\n')
  for (const [method, count] of stats(firstIndex)) process.stdout.write(`  ${method}: ${count}\n`)
  process.stdout.write(`第一轮文本: ${collectText(firstIndex)}\n`)

  autoApprove = true
  const secondIndex = frames.length
  await rpc('probe-turn-2', 'turn/start', {
    threadId,
    input: [{ type: 'text', text: '用 Bash 运行 echo qn-ok', text_elements: [] }],
  })
  const completed = await wait(
    (f) => f.t === 'codex.recv' && f.agent === 'claude' && f.msg?.method === 'turn/completed' && frames.indexOf(f) >= secondIndex,
    turnTimeout,
    '第二轮 turn/completed',
  )
  process.stdout.write(`第二轮 turn 状态: ${String(completed.msg?.params?.turn?.status ?? '')}\n`)
  process.stdout.write('第二轮通知统计:\n')
  for (const [method, count] of stats(secondIndex)) process.stdout.write(`  ${method}: ${count}\n`)
  process.stdout.write(`第二轮文本: ${collectText(secondIndex)}\n`)
  process.stdout.write(`命令输出: ${JSON.stringify(commandOutputs(secondIndex))}\n`)
  process.stdout.write(`自动批准的审批数: ${autoApproved.size}\n`)

  if (!explicitStateDir) await req('server.shutdown').catch(() => null)
  child.stdin.destroy()
  child.kill()
}

main()
  .catch((err) => {
    process.stderr.write(`claude-probe 失败: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    child.stdin.destroy()
    child.kill()
    if (tempRoot) {
      // 等 daemon 退出后再删临时 state dir，避免 Windows 上文件仍被占用。
      await sleep(300)
      try {
        rmSync(tempRoot, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响验收结果。
      }
    }
  })
