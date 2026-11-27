import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  buildConnectCommand,
  buildEnsureCommand,
  buildMkdirCommand,
  buildProbeCommand,
  buildServerCommand,
  buildWindowsServerCommand,
  parseJsonLine,
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
  buildWindowsConnectCommand,
  buildWindowsEnsureCommand,
  buildWindowsFallbackProbeCommand,
  buildWindowsMkdirCommand,
  buildWindowsProbeCommand,
  buildWindowsShaCommand,
  buildWindowsUploadCommand,
  isPosixProbe,
  parseWindowsProbe,
  windowsSftpPath,
  runtimeTargetKey,
  parseRuntimeManifest,
  runtimeInstallPath,
  buildRuntimeSelfTestCommand,
  buildRuntimeInstallCommand,
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
    expect(buildEnsureCommand('/usr/bin/node', path, true)).toBe(`'/usr/bin/node' ${posixQuote(path)} ensure --force-replace`)
    expect(buildConnectCommand('/usr/bin/node', path)).toContain('connect --stdio')
    expect(buildShaCommand('/usr/bin/sha256sum', path)).toContain('2>/dev/null || true')
    expect(buildMkdirCommand("/root/it's")).toContain('chmod 700')
    expect(buildUploadCommand('/tmp/x.tmp', path)).toContain('mv -f')
  })
})

describe('远端探测解析', () => {
  const probe = [
    'QN_OS=Linux',
    'QN_HOME=/root',
    'QN_ARCH=x86_64',
    'QN_NODE=/usr/bin/node',
    'QN_NODE_VER=v26.1.0',
    'QN_SHA256SUM=/usr/bin/sha256sum',
  ].join('\n')

  it('解析一次 exec 的探测输出', () => {
    expect(parseProbe(`banner\n${probe}\n`)).toEqual({
      os: 'Linux',
      home: '/root',
      arch: 'x86_64',
      nodePath: '/usr/bin/node',
      nodeVersion: 'v26.1.0',
      sha256sumPath: '/usr/bin/sha256sum',
    })
    expect(buildProbeCommand()).toContain('QN_HOME=%s')
  })

  it('Node 缺失 / 低于 18 返回空 nodePath，其它校验仍然报错', () => {
    const noNode = parseProbe(probe.replace('/usr/bin/node\n', '\n'))
    expect(noNode.nodePath).toBe('')
    expect(noNode.nodeVersion).toBe('')
    const oldNode = parseProbe(probe.replace('v26.1.0', 'v16.20.0'))
    expect(oldNode.nodePath).toBe('')
    expect(oldNode.nodeVersion).toBe('')
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

describe.skipIf(process.platform === 'win32')('POSIX Node 探测', () => {
  it.each([
    { pathVersion: 'v20.1.0', expected: 'bin/node', version: 'v20.1.0' },
    { pathVersion: 'v16.20.0', expected: 'node manager/versions/node/v22.1.0/bin/node', version: 'v22.1.0' },
    { pathVersion: null, expected: '.local/share/fnm/node-versions/v24.1.0/installation/bin/node', version: 'v24.1.0' },
  ])('优先使用合格的 PATH Node 并回退到用户安装目录（PATH 版本 $pathVersion）', async ({ pathVersion, expected, version }) => {
    const home = mkdtempSync(join(tmpdir(), "qn-node-'"))
    try {
      const fakeNode = (relativePath: string, nodeVersion: string) => {
        const file = join(home, relativePath)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${nodeVersion}'\n`, { mode: 0o700 })
      }
      const bin = join(home, 'bin')
      mkdirSync(bin)
      symlinkSync('/bin/sh', join(bin, 'sh'))
      symlinkSync('/usr/bin/uname', join(bin, 'uname'))
      symlinkSync('/bin/sh', join(bin, 'sha256sum'))
      if (pathVersion) {
        fakeNode('bin/node', pathVersion)
        fakeNode('node manager/versions/node/v16.2.0/bin/node', 'v16.2.0')
        fakeNode('node manager/versions/node/v22.1.0/bin/node', 'v22.1.0')
      }
      fakeNode('.local/share/fnm/node-versions/v24.1.0/installation/bin/node', 'v24.1.0')
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', buildProbeCommand()], {
        encoding: 'utf8',
        env: { HOME: home, PATH: bin, NVM_DIR: join(home, 'node manager') },
      })
      expect(parseProbe(stdout)).toMatchObject({ home, nodePath: join(home, expected), nodeVersion: version })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
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

  it('ensure 结果带出旧版 daemon 未替换标记', () => {
    const base = { token: TOKEN, version: '0.0.1+aaa', pid: 42, started: false, endpoint: '/tmp/qn.sock' }
    expect(parseEnsureResult(JSON.stringify({ ...base, stale: true })).stale).toBe(true)
    expect(parseEnsureResult(JSON.stringify(base))).not.toHaveProperty('stale')
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

describe('Windows 远端', () => {
  const decode = (command: string): string => {
    const match = /Buffer\.from\('([A-Za-z0-9_-]+)','base64'\)/.exec(command)
    return Buffer.from(match?.[1] ?? '', 'base64url').toString('utf8')
  }
  const decodePowerShell = (command: string): string => {
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    return Buffer.from(command.split(' ').at(-1) ?? '', 'base64').toString('utf16le')
  }
  const probe = 'QN_OS=win32\r\nQN_HOME=C:/Users/Administrator\r\nQN_ARCH=x64\r\nQN_NODE_VER=v24.18.0\r\n'

  it('Git Bash 的 MINGW 与 cmd/PowerShell 的空输出都不算 POSIX', () => {
    expect(isPosixProbe('QN_OS=Linux\n')).toBe(true)
    expect(isPosixProbe('QN_OS=Darwin\n')).toBe(true)
    expect(isPosixProbe('QN_OS=MINGW64_NT-10.0-28000\n')).toBe(false)
    expect(isPosixProbe('QN_OS=$(uname -s)\n')).toBe(false)
    expect(isPosixProbe('')).toBe(false)
  })

  it('解析探测输出并校验 Node 版本', () => {
    expect(parseWindowsProbe(probe)).toMatchObject({ os: 'Windows', home: 'C:/Users/Administrator', arch: 'x64', nodePath: 'node' })
    expect(parseWindowsProbe(probe.replace('v24.18.0', 'v16.0.0'))).toMatchObject({ nodePath: '', nodeVersion: '' })
    expect(() => parseWindowsProbe(probe.replace('win32', 'linux'))).toThrow('无法识别远端系统')
  })

  it('发现 PATH 外的 Node 后，部署、连接和直连子命令使用同一个绝对路径', () => {
    const fallback = decodePowerShell(buildWindowsFallbackProbeCommand())
    expect(fallback).toContain("Join-Path $root 'nodejs\\node.exe'")
    expect(fallback).toContain('[int]$Matches[1] -lt 18')
    expect(fallback).toContain("Write-Output ('QN_NODE=' + $path)")

    const node = "C:\\Program Files\\o'brien\\node.exe"
    const { nodePath } = parseWindowsProbe(`${probe}QN_NODE=${node}\r\n`)
    expect(nodePath).toBe(node)
    const script = 'C:/Users/a b/qn.cjs'
    for (const [command, args] of [
      [buildWindowsMkdirCommand('C:/Users/a b', nodePath), '"-e"'],
      [buildWindowsShaCommand(script, nodePath), '"-e"'],
      [buildWindowsUploadCommand(`${script}.tmp`, script, nodePath), '"-e"'],
      [buildWindowsEnsureCommand(script, nodePath), `"${script}" "ensure" "--replace"`],
      [buildWindowsEnsureCommand(script, nodePath, true), `"${script}" "ensure" "--force-replace"`],
      [buildWindowsConnectCommand(script, nodePath), `"${script}" "connect" "--stdio"`],
      [buildWindowsServerCommand(script, ['direct', 'enable'], nodePath), `"${script}" "direct" "enable"`],
      [buildWindowsServerCommand(script, ['direct', 'grant', '--name', 'a "b"\\'], nodePath), '"a \\"b\\"\\\\"'],
    ] as const) {
      const launch = decodePowerShell(command)
      expect(launch).toContain("$start.FileName = 'C:\\Program Files\\o''brien\\node.exe'")
      expect(launch).toContain(args)
      expect(launch).toContain('$start.UseShellExecute = $false')
    }
  })

  it('文件操作命令不含任何需要按 shell 转义的字符', () => {
    const path = "C:/Users/o'brien $x/.qingcode-next/qn-server.cjs"
    for (const command of [
      buildWindowsProbeCommand(),
      buildWindowsMkdirCommand(path),
      buildWindowsShaCommand(path),
      buildWindowsUploadCommand(`${path}.tmp`, path),
    ]) {
      expect(command).toMatch(/^node -e "eval\(Buffer\.from\('[A-Za-z0-9_-]+','base64'\)\.toString\(\)\)"$/)
    }
    expect(decode(buildWindowsMkdirCommand(path))).toContain(JSON.stringify(path))
  })

  it('启动命令拒绝双引号内仍会展开的路径，SFTP 路径补前导斜杠', () => {
    expect(buildWindowsEnsureCommand('C:/Users/a b/qn.cjs')).toBe('node "C:/Users/a b/qn.cjs" ensure --replace')
    for (const bad of ['C:/a$b', 'C:/%TEMP%', 'C:/a`b', 'C:/a"b']) {
      expect(() => buildWindowsConnectCommand(bad)).toThrow('不支持的字符')
    }
    expect(windowsSftpPath('C:/Users/a/x')).toBe('/C:/Users/a/x')
    expect(windowsSftpPath('/root/x')).toBe('/root/x')
  })
})

describe('server 子命令', () => {
  it('POSIX 逐个引用参数', () => {
    expect(buildServerCommand('/usr/bin/node', '/h/q.cjs', ['direct', 'grant', '--name', "a'b"]))
      .toBe(`'/usr/bin/node' '/h/q.cjs' 'direct' 'grant' '--name' 'a'\\''b'`)
  })

  it('Windows 用双引号并拒绝危险字符', () => {
    expect(buildWindowsServerCommand('C:/q.cjs', ['direct', 'status'])).toBe('node "C:/q.cjs" "direct" "status"')
    expect(() => buildWindowsServerCommand('C:/q.cjs', ['%PATH%'])).toThrow()
  })

  it('取最后一行 JSON，失败时不回显原文', () => {
    expect(parseJsonLine('noise\n{"a":1}\n{"b":2}\n')).toEqual({ b: 2 })
    expect(() => parseJsonLine('secret-token')).toThrow('远端 server 输出无法解析')
  })
})

describe('内置 Node 运行时', () => {
  it('探测命令采集 arch 并在缺 sha256sum 时回退 shasum', () => {
    const cmd = buildProbeCommand()
    expect(cmd).toContain('QN_ARCH=%s')
    expect(cmd).toContain('uname -m')
    expect(cmd).toContain('shasum -a 256')
  })

  it('带参数的 sha 命令逐个引用，普通路径整体引用', () => {
    expect(buildShaCommand('shasum -a 256', '/root/node')).toContain("'shasum' '-a' '256'")
    expect(buildShaCommand('/usr/bin/sha256sum', '/root/node')).toContain("'/usr/bin/sha256sum'")
  })

  it('runtimeTargetKey 只接受受支持的平台', () => {
    expect(runtimeTargetKey('Linux', 'x86_64')).toBe('linux-x64')
    expect(runtimeTargetKey('Linux', 'amd64')).toBe('linux-x64')
    expect(runtimeTargetKey('Linux', 'aarch64')).toBe('linux-arm64')
    expect(runtimeTargetKey('Linux', 'arm64')).toBe('linux-arm64')
    expect(runtimeTargetKey('Darwin', 'x86_64')).toBe('darwin-x64')
    expect(runtimeTargetKey('Darwin', 'arm64')).toBe('darwin-arm64')
    expect(runtimeTargetKey('Darwin', 'aarch64')).toBe('darwin-arm64')
    expect(runtimeTargetKey('Windows', 'x86_64')).toBeNull()
    expect(runtimeTargetKey('Linux', 'riscv64')).toBeNull()
    expect(runtimeTargetKey('FreeBSD', 'amd64')).toBeNull()
  })

  it('parseRuntimeManifest 校验 sha256 与本地文件路径', () => {
    const manifest = {
      version: 'v20.11.1',
      targets: { 'linux-x64': { file: 'node-linux-x64', sha256: SHA } },
    }
    expect(parseRuntimeManifest(manifest)).toEqual(manifest)
    for (const bad of [
      null,
      { version: 1, targets: {} },
      { version: 'v20', targets: [] },
      { version: 'v20', targets: { x: { file: 'a', sha256: 'abc' } } },
      { version: 'v20', targets: { x: { file: 'a', sha256: SHA.toUpperCase() } } },
      { version: 'v20', targets: { x: { file: '../node', sha256: SHA } } },
      { version: 'v20', targets: { x: { file: '/etc/node', sha256: SHA } } },
      { version: 'v20', targets: { x: { file: 'C:/node', sha256: SHA } } },
      { version: 'v20', targets: { x: { file: 'a', sha256: SHA }, y: { file: 'b' } } },
    ]) {
      expect(() => parseRuntimeManifest(bad)).toThrow('内置 Node 清单无效')
    }
  })

  it('运行时路径按 sha256 内容寻址', () => {
    expect(runtimeInstallPath('/root', SHA)).toBe(`/root/.qingcode-next/runtimes/node-${SHA.slice(0, 16)}/bin/node`)
    expect(parentPosixPath(runtimeInstallPath('/root', SHA))).toBe(`/root/.qingcode-next/runtimes/node-${SHA.slice(0, 16)}/bin`)
  })

  it('自检与安装命令转义所有路径', () => {
    const node = "/root/it's/bin/node"
    expect(buildRuntimeSelfTestCommand(node)).toBe(`${posixQuote(node)} -e 0 && echo QN_NODE_OK`)
    expect(buildRuntimeInstallCommand(node + '.tmp', node)).toBe(
      `chmod 755 ${posixQuote(node + '.tmp')} && mv -f ${posixQuote(node + '.tmp')} ${posixQuote(node)}`
    )
  })
})
