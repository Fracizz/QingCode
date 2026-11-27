import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyAgentEnv, installShim, pathKey, shimScripts } from './env'

describe('qn 启动脚本', () => {
  it('cmd 与 sh 都转发全部参数，Electron 以 node 模式运行时带上开关', () => {
    const plain = shimScripts({ execPath: 'C:\\Program Files\\node.exe', script: 'C:\\qn\\qn-server.cjs', electronAsNode: false })
    expect(plain.cmd).toContain('"C:\\Program Files\\node.exe" "C:\\qn\\qn-server.cjs" qn %*')
    expect(plain.cmd).not.toContain('ELECTRON_RUN_AS_NODE')
    const electron = shimScripts({ execPath: "/opt/it's/electron", script: '/s/qn-server.cjs', electronAsNode: true })
    expect(electron.sh).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/opt/it'\\''s/electron' '/s/qn-server.cjs' qn "$@"`)
    expect(electron.cmd).toContain('set ELECTRON_RUN_AS_NODE=1')
  })

  it('写入 bin 目录下的两份脚本', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-shim-'))
    try {
      const result = installShim(dir, { execPath: process.execPath, script: '/s.cjs', electronAsNode: false }, 'win32')
      expect(result.cli).toBe(path.join(dir, 'bin', 'qn.cmd'))
      expect(fs.existsSync(path.join(dir, 'bin', 'qn'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('applyAgentEnv', () => {
  it('Windows 沿用已有 Path 键并把 bin 放在最前，重复调用不重复添加', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\a;C:\\b' }
    const values = { endpoint: '\\\\.\\pipe\\qn', token: 't', binDir: 'C:\\qn\\bin', cli: 'C:\\qn\\bin\\qn.cmd' }
    applyAgentEnv(env, values, 'win32')
    applyAgentEnv(env, values, 'win32')
    expect(pathKey(env, 'win32')).toBe('Path')
    expect(env.Path).toBe('C:\\qn\\bin;C:\\a;C:\\b')
    expect(env.PATH).toBeUndefined()
    expect(env).toMatchObject({ QN_ENDPOINT: values.endpoint, QN_AGENT_TOKEN: 't', QN_CLI: values.cli })
  })

  it('POSIX 用 PATH 与冒号', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    applyAgentEnv(env, { endpoint: '/run/qn.sock', token: 't', binDir: '/run/bin', cli: '/run/bin/qn' }, 'linux')
    expect(env.PATH).toBe('/run/bin:/usr/bin')
  })
})
