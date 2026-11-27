import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunDataEvt, RunExitEvt } from './types'
import type { WorkspaceContext } from '../registry'
import { RunManager } from './manager'

// 真实子进程的集成测试：每个用例都有超时，不启动任何长期运行的服务。

const isWindows = process.platform === 'win32'

type Events = { data: RunDataEvt[]; exits: RunExitEvt[] }

function fakeContext(events: Events): { ctx: WorkspaceContext; close: () => void } {
  const cleanups: Array<() => void> = []
  const ctx: WorkspaceContext = {
    clientId: 1,
    emit(name, payload) {
      if (name === 'run.data') events.data.push(payload as RunDataEvt)
      if (name === 'run.exit') events.exits.push(payload as RunExitEvt)
    },
    onClose(cleanup) {
      cleanups.push(cleanup)
    },
    log() {},
  }
  return { ctx, close: () => cleanups.forEach((fn) => fn()) }
}

async function waitExit(events: Events, runId: string, timeoutMs = 10_000): Promise<RunExitEvt> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exit = events.exits.find((item) => item.runId === runId)
    if (exit) return exit
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`run ${runId} 未在 ${timeoutMs}ms 内结束`)
}

function textOf(events: Events, runId: string, stream?: 'stdout' | 'stderr'): string {
  return events.data
    .filter((item) => item.runId === runId && (!stream || item.stream === stream))
    .map((item) => item.data)
    .join('')
}

let dir = ''
let manager: RunManager
const events: Events = { data: [], exits: [] }

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-run-'))
  manager = new RunManager()
  manager.subscribe(fakeContext(events).ctx)
})

afterAll(async () => {
  await manager.stopAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.runIf(isWindows)('RunManager（Windows）', () => {
  it('command 经 cmd 执行，区分 stdout/stderr，注入 FORCE_COLOR 与 task.env', async () => {
    const { runId, pid } = await manager.start({
      cwd: dir,
      task: { type: 'command', target: 'echo hello %FORCE_COLOR% %MODE% && echo oops 1>&2', env: { MODE: "it's" } },
      label: 'echo',
      key: 'c/t',
    })
    expect(pid).toBeGreaterThan(0)
    const exit = await waitExit(events, runId)
    expect(exit.exitCode).toBe(0)
    expect(textOf(events, runId, 'stdout')).toContain("hello 1 it's")
    expect(textOf(events, runId, 'stderr')).toContain('oops')
    const info = manager.list().find((item) => item.runId === runId)
    expect(info).toMatchObject({ label: 'echo', key: 'c/t', cwd: dir, exitCode: 0 })
    expect(info?.endedAt).toBeGreaterThan(0)
    const output = manager.output(runId, 0)
    expect(output.running).toBe(false)
    expect(output.chunks.map((c) => c.data).join('')).toContain('hello')
    expect(manager.output(runId, output.lastSeq).chunks).toEqual([])
  }, 20_000)

  it('bat 在子目录 cwd 下运行并返回退出码', async () => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'hi there.bat'), '@echo off\r\necho bat-ok %CD%\r\nexit /b 7\r\n')
    const { runId } = await manager.start({ cwd: dir, task: { type: 'bat', target: 'hi there.bat', cwd: 'sub' } })
    const exit = await waitExit(events, runId)
    expect(exit.exitCode).toBe(7)
    expect(textOf(events, runId)).toContain('bat-ok')
    expect(textOf(events, runId)).toContain('sub')
  }, 20_000)

  it('ps1 用 powershell -File 执行', async () => {
    fs.writeFileSync(path.join(dir, 'job.ps1'), 'Write-Output "ps1-ok $env:MODE"\r\nexit 3\r\n')
    const { runId } = await manager.start({ cwd: dir, task: { type: 'script', target: 'job.ps1', env: { MODE: 'm' } } })
    const exit = await waitExit(events, runId, 30_000)
    expect(textOf(events, runId)).toContain('ps1-ok m')
    expect(exit.exitCode).toBe(3)
  }, 40_000)

  it('run.stop 用 taskkill 结束进程树', async () => {
    const { runId } = await manager.start({ cwd: dir, task: { type: 'command', target: 'ping -n 60 127.0.0.1' } })
    expect(manager.activeCount()).toBeGreaterThan(0)
    await manager.stop(runId)
    const exit = await waitExit(events, runId)
    expect(exit.exitCode).not.toBe(0)
    // 已结束的再停一次是幂等的。
    await manager.stop(runId)
  }, 20_000)

  it('工作目录不存在时报 not_found', async () => {
    await expect(
      manager.start({ cwd: dir, task: { type: 'command', target: 'echo x', cwd: 'missing' } }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe.runIf(!isWindows)('RunManager（POSIX）', () => {
  it('command 走 sh -lc，stop 杀进程组', async () => {
    const { runId } = await manager.start({ cwd: dir, task: { type: 'command', target: 'echo hi $FORCE_COLOR' } })
    expect((await waitExit(events, runId)).exitCode).toBe(0)
    expect(textOf(events, runId)).toContain('hi 1')
    const long = await manager.start({ cwd: dir, task: { type: 'command', target: 'sleep 60' } })
    await manager.stop(long.runId)
    const exit = await waitExit(events, long.runId)
    expect(exit.signal ?? exit.exitCode).toBeTruthy()
  }, 20_000)
})
