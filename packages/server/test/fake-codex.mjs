// 端到端测试用的假 codex app-server：stdin JSONL → stdout JSONL。
// 参数 1 是审批响应日志路径，用来验证「第一个响应生效」。
import fs from 'node:fs'

const logPath = process.argv[2] ?? ''
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const log = (text) => {
  if (logPath) fs.appendFileSync(logPath, `${text}\n`)
}

let input = ''
let ticks = 0

function handle(msg) {
  if (msg.method === 'initialize') {
    write({
      id: msg.id,
      result: {
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
        userAgent: 'fake-codex/0.172.0',
      },
    })
    return
  }
  if (msg.method === 'initialized') return
  // 测试 codex 退出：hang 故意不响应，exit 主动结束进程。
  if (msg.method === 'fake/hang') return
  if (msg.method === 'fake/exit') {
    process.exit(3)
    return
  }
  if (msg.method === 'thread/start' && msg.params?.sandbox === 'read-only') {
    write({ id: msg.id, result: {
      thread: { id: 'scheduled-thread' },
      sandbox: { type: 'readOnly', networkAccess: false },
      approvalPolicy: msg.params.approvalPolicy,
      approvalsReviewer: msg.params.approvalsReviewer,
    } })
    return
  }
  if (msg.method === 'turn/start' && msg.params?.threadId === 'scheduled-thread') {
    const params = { threadId: 'scheduled-thread', turn: { id: 'scheduled-turn', status: 'inProgress' } }
    write({ id: msg.id, result: { turn: params.turn } })
    write({ method: 'turn/started', params })
    write({ id: 'scheduled-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: params.threadId, turnId: params.turn.id, command: 'echo hi',
    } })
    return
  }
  if (msg.id === 'scheduled-approval' && msg.result?.decision === 'decline') {
    write({ method: 'turn/completed', params: {
      threadId: 'scheduled-thread', turn: { id: 'scheduled-turn', status: 'completed' },
    } })
    return
  }
  if (msg.method === 'thread/start') {
    write({ id: msg.id, result: { thread: { id: 'thread-1' } } })
    write({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    write({ method: 'item/agentMessage/delta', params: { delta: 'hello' } })
    write({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'echo hi' },
    })
    return
  }
  if (msg.id === 'approval-1' && (msg.result !== undefined || msg.error !== undefined)) {
    log(`approval:${JSON.stringify(msg.result ?? msg.error)}`)
    write({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let index
  while ((index = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, index).trim()
    input = input.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))

// 断开期间持续产生广播消息，供 codex.attach 回放验证。
setInterval(() => {
  ticks += 1
  write({ method: 'tick', params: { n: ticks } })
}, 50)
