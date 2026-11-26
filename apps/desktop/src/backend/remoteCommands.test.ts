import { describe, expect, it } from 'vitest'
import {
  buildConnectCommand,
  buildEnsureCommand,
  buildMkdirCommand,
  buildProbeCommand,
  buildShaCommand,
  buildUploadCommand,
  formatSize,
  nodeMajor,
  parentPosixPath,
  parseEnsureResult,
  parseManifest,
  parseProbe,
  parseRemoteSha,
  posixQuote,
  redactToken,
  serverInstallPath,
} from './remoteCommands'

const SHA = 'a'.repeat(64)
const TOKEN = 'b'.repeat(64)

describe('POSIX 转义', () => {
  it('单引号内所有字符都按字面量传给远端', () => {
    expect(posixQuote('/root/.qingcode-next/server')).toBe("'/root/.qingcode-next/server'")
    expect(posixQuote("a'b")).toBe("'a'\\''b'")
    expect(posixQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'")
    expect(posixQuote('back\\slash')).toBe("'back\\slash'")
  })

  it('命令参数全部经过转义', () => {
    const path = "/root/it's bad/qn-server.cjs"
    expect(buildEnsureCommand('/usr/bin/node', path)).toContain(posixQuote(path))
    expect(buildConnectCommand('/usr/bin/node', path)).toContain('connect --stdio')
    expect(buildShaCommand('/usr/bin/sha256sum', path)).toContain('2>/dev/null || true')
    expect(buildMkdirCommand("/root/it's")).toContain('chmod 700')
    expect(buildUploadCommand('/tmp/x.tmp', path)).toContain('mv -f')
    expect(buildProbeCommand()).toContain('node -v')
  })
})

describe('远端探测解析', () => {
  const probe = [
    'QN_OS=Linux',
    'QN_HOME=/root',
    'QN_NODE=/usr/bin/node',
    'QN_NODE_VER=v26.1.0',
    'QN_SHA256SUM=/usr/bin/sha256sum',
  ].join('\n')

  it('解析一次 exec 的探测输出', () => {
    expect(parseProbe(`banner\n${probe}\n`)).toEqual({
      os: 'Linux',
      home: '/root',
      nodePath: '/usr/bin/node',
      nodeVersion: 'v26.1.0',
      sha256sumPath: '/usr/bin/sha256sum',
    })
    expect(buildProbeCommand()).toContain('QN_HOME=%s')
  })

  it('Node 缺失 / 低于 18 / 非 POSIX / 缺 sha256sum 都给出可读错误', () => {
    expect(() => parseProbe(probe.replace('/usr/bin/node\n', '\n'))).toThrow('远端需要 Node ≥ 18')
    expect(() => parseProbe(probe.replace('v26.1.0', 'v16.20.0'))).toThrow('远端需要 Node ≥ 18')
    expect(() => parseProbe(probe.replace('Linux', 'MINGW64_NT-10.0'))).toThrow('远端需要 POSIX 主机')
    expect(() => parseProbe(probe.replace('QN_SHA256SUM=/usr/bin/sha256sum', 'QN_SHA256SUM='))).toThrow('sha256sum')
    expect(() => parseProbe(probe.replace('QN_HOME=/root', 'QN_HOME='))).toThrow('$HOME')
    expect(nodeMajor('v18.0.0')).toBe(18)
    expect(nodeMajor('26.1.0')).toBe(26)
    expect(nodeMajor('unknown')).toBe(0)
  })

  it('server 安装路径内容寻址且不带多余斜杠', () => {
    const script = serverInstallPath('/root/', '0.0.1', SHA)
    expect(script).toBe(`/root/.qingcode-next/server/bin/0.0.1-${SHA.slice(0, 12)}/qn-server.cjs`)
    expect(parentPosixPath(script)).toBe(`/root/.qingcode-next/server/bin/0.0.1-${SHA.slice(0, 12)}`)
    expect(serverInstallPath('/root', '0.0/1', SHA)).toContain('0.0_1-')
  })
})

describe('清单 / 校验 / ensure 输出', () => {
  it('清单只接受完整 sha256', () => {
    expect(parseManifest({ version: '0.0.1', sha256: SHA })).toEqual({ version: '0.0.1', sha256: SHA })
    expect(() => parseManifest({ version: '0.0.1', sha256: 'abc' })).toThrow('清单无效')
    expect(() => parseManifest(null)).toThrow('清单无效')
  })

  it('sha256sum 输出解析', () => {
    expect(parseRemoteSha(`${SHA}  /root/some file/qn-server.cjs\n`)).toBe(SHA)
    expect(parseRemoteSha('sha256sum: command not found\n')).toBeNull()
    expect(parseRemoteSha('')).toBeNull()
  })

  it('ensure 结果解析且不泄漏 token', () => {
    const line = JSON.stringify({ token: TOKEN, version: '0.0.1', pid: 42, started: true, endpoint: '\\\\.\\pipe\\qn' })
    expect(parseEnsureResult(`noise\n${line}\n`)).toEqual({
      token: TOKEN,
      version: '0.0.1',
      pid: 42,
      started: true,
      endpoint: '\\\\.\\pipe\\qn',
    })
    let message = ''
    try {
      parseEnsureResult(`oops ${TOKEN}`)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('无法解析')
    expect(message).not.toContain(TOKEN)
    expect(() => parseEnsureResult('{"token":"short","endpoint":"x"}')).toThrow()
  })

  it('体积与 token 打码', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1258291)).toBe('1.2 MB')
    expect(redactToken(`failed ${TOKEN}`)).toBe('failed ***')
  })
})
