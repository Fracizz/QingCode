import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { buildProbeCommand } from './remoteCommands'
import { connectSshTarget, testSshTarget } from './sshTarget'
import { ServerClient } from './serverClient'

let home: string
const uploads: string[] = []
const exec = promisify(execFile)
type Channel = EventEmitter & { stderr: EventEmitter }
type Done = (error?: unknown) => void
type Sftp = { end(): void; fastPut(local: string, remote: string, done: Done): void }

vi.mock('ssh2', () => ({
  Client: class extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('ready')) }
    end() {}
    exec(command: string, cb: (error: null, channel: Channel) => void) {
      const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
      cb(null, channel)
      const run = command === buildProbeCommand()
        ? Promise.resolve({ stdout: `QN_OS=Linux\nQN_HOME=${home}\nQN_ARCH=x86_64\nQN_SHA256SUM=sha256sum` })
        : exec('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home } })
      void run.then(({ stdout }) => {
        channel.emit('data', stdout)
        channel.emit('exit', 0)
      }, () => channel.emit('exit', 1)).finally(() => channel.emit('close'))
    }
    sftp(cb: (error: null, sftp: Sftp) => void) {
      cb(null, {
        end() {},
        fastPut(local, remote, done) {
          uploads.push(local)
          void copyFile(local, remote).then(() => done(), done)
        },
      })
    }
    openssh_forwardOutStreamLocal(_path: string, cb: (error: null, channel: { stderr: EventEmitter; close(): void }) => void) {
      cb(null, { stderr: new EventEmitter(), close() {} })
    }
  },
}))

const sha = (data: string) => createHash('sha256').update(data).digest('hex')

it.skipIf(process.platform !== 'linux').each(['node-runtime', 'server/node-runtime'])(
  '默认 SSH 在缺少系统 Node 时，从 %s 试连、部署并复用已校验的运行时',
  async (layout) => {
    home = await mkdtemp(join(tmpdir(), 'qn-ssh-runtime-'))
    const resourcesPath = join(home, 'resources')
    const runtime = join(resourcesPath, layout)
    const server = join(resourcesPath, 'server')
    const script = 'console.log(JSON.stringify({token:"0".repeat(64),endpoint:"/tmp/qn.sock"}))'
    const node = `#!/bin/sh\nexec "${process.execPath}" "$@"\n`
    const handshake = vi.spyOn(ServerClient, 'connect').mockResolvedValue({ close() {} } as ServerClient)
    try {
      await mkdir(runtime, { recursive: true })
      await mkdir(server, { recursive: true })
      await writeFile(join(runtime, 'node'), node)
      await writeFile(join(runtime, 'manifest.json'), JSON.stringify({
        version: process.version, targets: { 'linux-x64': { file: 'node', sha256: sha(node) } },
      }))
      await writeFile(join(server, 'qn-server.cjs'), script)
      await writeFile(join(server, 'qn-server.json'), JSON.stringify({ version: '1', sha256: sha(script) }))
      const context = {
        resourcesPath, userData: home, appVersion: '1',
        target: { kind: 'ssh', id: 't', name: 'test', host: 'host', port: 22, username: 'u', auth: { kind: 'password' } },
        credentials: { password: 'test' }, gate: { verify: async () => true },
        hooks: { onState: vi.fn(), onClose: vi.fn(), onEvent: vi.fn(), onCodexRecv: vi.fn() },
      } as const
      uploads.length = 0
      expect((await testSshTarget(context)).nodeVersion).toBe(`内置 ${process.version}（连接时推送）`)
      expect(uploads).toEqual([])
      const first = await connectSshTarget(context)
      first.close()
      const reconnected = await connectSshTarget(context)
      reconnected.close()
      expect(handshake).toHaveBeenCalledTimes(2)
      expect(uploads).toEqual([join(runtime, 'node'), join(server, 'qn-server.cjs')])
    } finally {
      handshake.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  },
)
