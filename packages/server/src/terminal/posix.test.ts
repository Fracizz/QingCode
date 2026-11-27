// 真实 PTY 集成测试：需要 POSIX + python3（script 用例另需 util-linux script）；Windows 上整体跳过。
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceContext } from '../workspace/registry'
import { parseOpenParams } from './logic'
import { TerminalManager } from './manager'
import { probeCapabilities } from './posix'
import type { TermDataEvt, TermExitEvt } from './types'

const posix = process.platform !== 'win32'
const hasPython = posix && spawnSync('python3', ['-I', '-c', 'import pty, termios'], { timeout: 5000 }).status === 0
const hasScript =
  posix && String(spawnSync('script', ['--help'], { encoding: 'utf8', timeout: 5000 }).stdout ?? '').includes('--return')

function collector() {
  const events: Array<{ name: string; payload: unknown }> = []
  const ctx: WorkspaceContext = {
    clientId: 1,
    emit: (name, payload) => events.push({ name, payload }),
    onClose: () => {},
    log: () => {},
  }
  const text = (): string =>
    events
      .filter((e) => e.name === 'term.data')
      .map((e) => Buffer.from((e.payload as TermDataEvt).data, 'base64').toString('utf8'))
      .join('')
  const exit = (): TermExitEvt | undefined =>
    events.find((e) => e.name === 'term.exit')?.payload as TermExitEvt | undefined
  return { ctx, events, text, exit }
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const b64 = (text: string): Buffer => Buffer.from(text, 'utf8')
const managers: TerminalManager[] = []

afterEach(() => {
  for (const m of managers.splice(0)) m.shutdown()
})

function open(m: TerminalManager, ctx: WorkspaceContext, extra: Record<string, unknown> = {}) {
  return m.open(parseOpenParams({ cwd: os.tmpdir(), shell: '/bin/sh', cols: 80, rows: 24, ...extra }), ctx)
}

describe.skipIf(!hasPython)('python3 PTY 桥（真实进程）', () => {
  it('探测到 python3', async () => {
    const caps = await probeCapabilities()
    expect(caps.python3.ok).toBe(true)
  })

  it('交互、中文、resize、退出码', async () => {
    const m = new TerminalManager()
    managers.push(m)
    const c = collector()
    const opened = await open(m, c.ctx, { backend: 'python' })
    expect(opened.backend).toBe('python')
    m.write(opened.termId, b64('echo QN_$((40+2)) 中文✓\r'))
    await waitFor(() => c.text().includes('QN_42 中文✓'))
    expect(m.resize(opened.termId, 120, 40, c.ctx).applied).toBe(true)
    m.write(opened.termId, b64('stty size\r'))
    await waitFor(() => c.text().includes('40 120'))
    m.write(opened.termId, b64('exit 7\r'))
    await waitFor(() => c.exit() !== undefined)
    expect(c.exit()).toMatchObject({ code: 7, signal: null })
    expect(m.activeCount).toBe(0)
  })

  it('shell 退出即结束，即使后台进程仍持有 pty', async () => {
    const m = new TerminalManager()
    managers.push(m)
    const c = collector()
    const opened = await open(m, c.ctx, { backend: 'python' })
    m.write(opened.termId, b64('sleep 5 & exit 3\r'))
    await waitFor(() => c.exit() !== undefined, 5000)
    expect(c.exit()?.code).toBe(3)
  })

  it('close 结束会话并上报信号退出', async () => {
    const m = new TerminalManager()
    managers.push(m)
    const c = collector()
    const opened = await open(m, c.ctx, { backend: 'python' })
    m.close(opened.termId)
    await waitFor(() => c.exit() !== undefined, 6000)
    expect(m.list().terminals).toEqual([])
  })
})

describe.skipIf(!hasScript)('script 兜底（真实进程）', () => {
  it('交互与退出码，resize 不生效', async () => {
    const m = new TerminalManager()
    managers.push(m)
    const c = collector()
    const opened = await open(m, c.ctx, { backend: 'script', cols: 100, rows: 30 })
    expect(opened).toMatchObject({ backend: 'script', supportsResize: false })
    m.write(opened.termId, b64('stty size; echo QN_OK\r'))
    await waitFor(() => c.text().includes('QN_OK') && c.text().includes('30 100'))
    expect(m.resize(opened.termId, 120, 40, c.ctx).applied).toBe(false)
    m.write(opened.termId, b64('exit 5\r'))
    await waitFor(() => c.exit() !== undefined)
    expect(c.exit()?.code).toBe(5)
  })
})
