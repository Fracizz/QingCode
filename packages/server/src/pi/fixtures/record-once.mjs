// 一次性录制脚本（不参与构建）：用隔离的临时 session-dir 跑一次真实 pi RPC，
// 只发一个最小 prompt，stdout 的 JSONL 原样写入 fixtures 同目录。
// 用完即可删除；fixture 入库前须人工确认不含凭据/敏感路径。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-pi-record-'))
const cwd = path.join(root, 'work')
const sessionDir = path.join(root, 'sessions')
fs.mkdirSync(cwd, { recursive: true })
fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n')
fs.mkdirSync(sessionDir, { recursive: true })
const out = path.join(here, 'real-prompt.raw.jsonl')
const command = process.platform === 'win32' ? 'pi.cmd' : 'pi'
const args = [
  '--mode', 'rpc',
  '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes',
  '--no-context-files', '--offline',
  '--session-dir', sessionDir,
  '--session-id', 'qn-pi-fixture',
  '--thinking', 'off',
]
console.log('cwd=', cwd, 'args=', args.join(' '))
const child = spawn(command, args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: process.platform === 'win32',
  env: { ...process.env },
})
const fd = fs.openSync(out, 'w')
let remainder = ''
let settled = false
const t0 = Date.now()
child.stdout.on('data', (chunk) => {
  fs.writeSync(fd, chunk)
  remainder += chunk.toString('utf8')
  let idx
  while ((idx = remainder.indexOf('\n')) >= 0) {
    const line = remainder.slice(0, idx).trim()
    remainder = remainder.slice(idx + 1)
    if (!line) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    console.log('EVT', rec.type ?? '?', rec.command ?? rec.assistantMessageEvent?.type ?? '')
    if (rec.type === 'response' && rec.command === 'get_state') {
      child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: '列出当前目录' }) + '\n')
    }
    if (rec.type === 'agent_settled') {
      settled = true
      finish()
    }
  }
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
child.on('error', (err) => { console.error('spawn error', err.message); finish() })
child.on('exit', (code) => { console.log('exit', code, 'settled=', settled, 'ms=', Date.now() - t0); finish() })
let done = false
function finish() {
  if (done) return
  done = true
  try { child.stdin.end() } catch {}
  fs.closeSync(fd)
  if (stderr) console.log('stderr=', stderr.slice(0, 800))
  setTimeout(() => { try { child.kill() } catch {} }, 3000).unref()
}
child.stdin.on('error', () => {})
child.stdin.write(JSON.stringify({ id: 's1', type: 'get_state' }) + '\n')
setTimeout(() => { console.log('timeout, settled=', settled); finish() }, 90_000).unref()
