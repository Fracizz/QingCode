import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IpcClient } from '../client'
import { resolvePaths } from '../paths'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const mainEntry = path.join(srcDir, '..', 'main.ts')

type Frame = Record<string, unknown>

let root = ''
let bundle = ''
let token = ''
let daemonPid = 0
let endpoint = ''
let desktop: IpcClient
let runId = ''
const desktopFrames: Frame[] = []
let qnEnv: Record<string, string> = {}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function qn(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bundle, 'qn', ...args], {
      cwd: root, env: { ...process.env, ...qnEnv }, timeout: 30_000, windowsHide: true, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

describe('qn 端到端（真实 daemon）', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-agentctl-e2e-'))
    const stateDir = path.join(root, 'state')
    bundle = path.join(root, 'qn-server.cjs')
    fs.mkdirSync(stateDir, { recursive: true })
    await build({ entryPoints: [mainEntry], outfile: bundle, bundle: true, platform: 'node', target: 'node18', format: 'cjs', logLevel: 'silent' })
    const ensured = spawnSync(process.execPath, [bundle, 'ensure', '--state-dir', stateDir], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    if (ensured.status !== 0) throw new Error(`ensure 失败: ${ensured.stderr}`)
    const parsed = JSON.parse(ensured.stdout.trim()) as { token: string; pid: number }
    token = parsed.token
    daemonPid = parsed.pid
    endpoint = resolvePaths(stateDir).endpoint

    desktop = await IpcClient.connectEndpoint(endpoint, token, 3000, 'e2e-desktop')
    desktop.onFrame = (frame) => desktopFrames.push(frame)
    // daemon 拉起的子进程（这里用运行配置代替 Agent）继承到的 qn 环境。
    const dump = path.join(root, 'dump-env.cjs')
    fs.writeFileSync(dump, `const keys = Object.keys(process.env).filter((k) => k.startsWith('QN_') || k.toUpperCase() === 'PATH')
console.log('ENV' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))))
console.log('\\x1b[32mdone\\x1b[0m')
`)
    const started = await desktop.request('run.start', {
      cwd: root, label: 'dump', task: { type: 'command', target: `"${process.execPath}" "${dump}"` },
    }) as { runId: string }
    runId = started.runId
    const output = await until(async () => {
      const result = await desktop.request('run.output', { runId }) as { running: boolean; chunks: Array<{ data: string }> }
      return result.running ? undefined : result.chunks.map((chunk) => chunk.data).join('')
    })
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith('ENV')) ?? 'ENV{}'
    qnEnv = JSON.parse(line.slice(3)) as Record<string, string>
  }, 90_000)

  afterAll(async () => {
    await desktop?.request('server.shutdown').catch(() => null)
    desktop?.close()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        process.kill(daemonPid, 0)
      } catch {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    fs.rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('daemon 的子进程拿到 qn 的连接信息与 PATH', () => {
    expect(qnEnv.QN_AGENT_TOKEN).toMatch(/^[0-9a-f]{48}$/)
    expect(qnEnv.QN_AGENT_TOKEN).not.toBe(token)
    expect(qnEnv.QN_ENDPOINT).toBe(endpoint)
    expect(fs.existsSync(qnEnv.QN_CLI ?? '')).toBe(true)
    const pathValue = Object.entries(qnEnv).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    expect(pathValue.startsWith(path.dirname(qnEnv.QN_CLI ?? ''))).toBe(true)
  })

  it('qn notify / qn open 广播给界面客户端', async () => {
    const notify = await qn(['notify', '构建完成', '--title', 'CI'])
    expect(notify).toMatchObject({ code: 0 })
    expect(notify.stdout).toContain('已提醒用户')
    const evt = await until(() => desktopFrames.find((f) => f.t === 'evt' && f.name === 'ui.notify'))
    expect(evt.payload).toEqual({ body: '构建完成', title: 'CI' })

    const open = await qn(['open', 'src/a.ts', '--line', '3'])
    expect(open.code).toBe(0)
    const opened = await until(() => desktopFrames.find((f) => f.t === 'evt' && f.name === 'ui.open'))
    expect(opened.payload).toEqual({ path: path.resolve(root, 'src/a.ts'), line: 3 })
  })

  it('qn run list / output 只读查看运行配置', async () => {
    const list = await qn(['run', 'list'])
    expect(list.stdout).toContain(runId)
    expect(list.stdout).toContain('dump')
    const output = await qn(['run', 'output', runId, '--tail', '1'])
    expect(output.code).toBe(0)
    expect(output.stdout).toContain('done\n--- lastSeq=')
    expect(output.stdout).not.toContain('\x1b[')
  })

  it('qn status', async () => {
    const status = await qn(['status', '--json'])
    expect(JSON.parse(status.stdout)).toMatchObject({ cwd: root })
  })

  it('agent token 只能调用白名单，且不能收发 Agent 协议消息', async () => {
    const agent = await IpcClient.connectEndpoint(endpoint, qnEnv.QN_AGENT_TOKEN ?? '', 3000, 'e2e-agent')
    try {
      await expect(agent.request('run.start', { cwd: root, task: { type: 'command', target: 'echo hi' } })).rejects.toThrow('qn 不允许调用 run.start')
      await expect(agent.request('server.shutdown')).rejects.toThrow('qn 不允许调用')
      await expect(agent.request('codex.open', {})).rejects.toThrow('qn 不允许调用')
      await expect(agent.request('fs.write', { path: path.join(root, 'x'), content: '' })).rejects.toThrow('qn 不允许调用')
      let closed = false
      agent.onClose = () => { closed = true }
      agent.send({ t: 'codex.send', msg: { id: 'approval-1', result: { decision: 'accept' } } })
      await until(() => (closed ? true : undefined))
    } finally {
      agent.close()
    }
    // 主连接不受影响。
    expect(await desktop.request('ping')).toMatchObject({ serverVersion: expect.any(String) })
  })
})
