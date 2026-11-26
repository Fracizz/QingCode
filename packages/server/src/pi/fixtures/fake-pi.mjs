// 测试用的假 pi RPC 进程（不参与构建）：按 rpc.md 的形状回命令响应，
// 并把 fixtures/real-prompt.jsonl 里真实录制的事件回放出去。不访问网络、不读凭据。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const events = fs
  .readFileSync(path.join(here, 'real-prompt.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
const respond = (id, command, data) =>
  write({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })

const history = [
  { role: 'user', content: [{ type: 'text', text: '列出当前目录' }], timestamp: 1 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: '好的，已经列出。' }],
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    stopReason: 'stop',
    timestamp: 2,
  },
]

let running = false
let remainder = ''

const replay = () => {
  for (const line of events) {
    process.stdout.write(`${line}\n`)
    const record = JSON.parse(line)
    if (record.type === 'agent_settled') running = false
  }
}

const handle = (record) => {
  const { id, type } = record
  switch (type) {
    case 'new_session':
      return respond(id, type, { cancelled: false })
    case 'get_state':
      return respond(id, type, {
        sessionId: 'fake-pi-session',
        sessionFile: path.join(here, 'fake-pi-session.jsonl'),
        messageCount: 0,
        isStreaming: running,
      })
    case 'switch_session':
      return respond(id, type, { cancelled: false })
    case 'get_messages':
      return respond(id, type, { messages: history })
    case 'get_available_models':
      return respond(id, type, { models: [] })
    case 'prompt':
      respond(id, type, { disposition: 'started' })
      running = true
      replay()
      return
    case 'abort':
      respond(id, type)
      if (running) {
        running = false
        write({ type: 'agent_settled', aborted: true })
      }
      return
    default:
      return write({ id, type: 'response', command: type, success: false, error: 'unsupported command' })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  remainder += chunk
  let index
  while ((index = remainder.indexOf('\n')) >= 0) {
    const line = remainder.slice(0, index).trim()
    remainder = remainder.slice(index + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch {
      write({ type: 'response', command: 'parse', success: false, error: 'invalid JSON' })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
