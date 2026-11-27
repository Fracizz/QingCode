import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openEndpoint, runLocalEnsure } from './localTarget'

const dirs: string[] = []
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'qn-local-target-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const TOKEN = 'f'.repeat(64)

describe('runLocalEnsure', () => {
  it('读取 ensure 的 stdout JSON（不在错误信息里泄漏 token）', async () => {
    const dir = await tempDir()
    const script = join(dir, 'fake-ensure.cjs')
    await writeFile(script, `process.stdout.write(JSON.stringify({token:'${TOKEN}',version:'0.0.1',pid:7,started:true,endpoint:'\\\\\\\\.\\\\pipe\\\\qn-test'})+'\\n')\n`)
    const result = await runLocalEnsure(process.execPath, script, 3_000)
    expect(result.token).toBe(TOKEN)
    expect(result.pid).toBe(7)
    expect(result.endpoint).toContain('pipe')
  })

  it('非零退出码与无效 JSON 都失败，且不回显 stdout', async () => {
    const dir = await tempDir()
    const failing = join(dir, 'fail.cjs')
    await writeFile(failing, `process.stdout.write('${TOKEN}\\n');process.stderr.write('boom\\n');process.exit(3)\n`)
    await expect(runLocalEnsure(process.execPath, failing, 3_000)).rejects.toThrow('boom')

    const garbage = join(dir, 'garbage.cjs')
    await writeFile(garbage, `process.stdout.write('${TOKEN}\\n')\n`)
    await expect(runLocalEnsure(process.execPath, garbage, 3_000)).rejects.toThrow('无法解析')
  })
})

describe('openEndpoint', () => {
  it('连接 ensure 给出的本地 IPC 地址', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\qn-test-${randomUUID()}`
      : join(await tempDir(), 'daemon.sock')
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ path: endpoint }, () => resolve())
    })
    try {
      const socket = await openEndpoint(endpoint, 3_000)
      expect(socket.writable).toBe(true)
      socket.destroy()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
