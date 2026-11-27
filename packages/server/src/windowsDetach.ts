// Windows 的 sshd 在会话结束时会连同 job 里的子进程一起结束，detached 拉起的 daemon 也不例外。
// 经 WMI 创建的进程不属于该 job，才能在断开 SSH 后继续常驻。
import { spawnSync } from 'node:child_process'

const COMMAND_ENV = 'QN_DAEMON_COMMAND'
const TIMEOUT_MS = 8_000

// WMI 默认不继承调用者环境，需要显式传入，否则 daemon 里的 PATH 与 SSH 会话不一致。
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$vars = [string[]](Get-ChildItem Env: | Where-Object { $_.Name -ne '${COMMAND_ENV}' } | ForEach-Object { "$($_.Name)=$($_.Value)" })`,
  '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $vars }',
  `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:${COMMAND_ENV}; ProcessStartupInformation = $startup }`,
  'if ($result.ReturnValue -ne 0) { exit 1 }',
].join('\n')

export function needsJobBreakaway(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && Boolean(env.SSH_CONNECTION)
}

/** 拼 Windows 命令行；参数是文件路径，本身不可能含双引号。 */
export function windowsCommandLine(parts: string[]): string {
  return parts
    .map((part) => {
      if (part.includes('"')) throw new Error('参数包含双引号')
      // 引号前的反斜杠会转义引号，结尾反斜杠需要成对。
      return `"${part.replace(/(\\+)$/, '$1$1')}"`
    })
    .join(' ')
}

/** 成功返回 true；WMI 不可用（如权限不足）返回 false，由调用方退回普通拉起。 */
export function spawnOutsideJob(program: string, args: string[]): boolean {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    {
      env: { ...process.env, [COMMAND_ENV]: windowsCommandLine([program, ...args]) },
      windowsHide: true,
      stdio: 'ignore',
      timeout: TIMEOUT_MS,
    },
  )
  return result.status === 0
}
