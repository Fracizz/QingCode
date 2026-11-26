import { spawn } from 'node:child_process'

const ENTROPY = 'qingcode-ssh-secret-v1'
const POWERSHELL_TIMEOUT_MS = 20_000
const MAX_OUTPUT = 1 << 20

// PowerShell 的 `-Command -` 会把 stdin 逐行当脚本执行，无法再单独读数据流；
// 因此把 base64 密文作为脚本里的 JSON 字面量一起经 stdin 送入，密文不进命令行、不落盘、不进日志。
export function buildDpapiScript(encoded: readonly string[]): string {
  const json = JSON.stringify(encoded).replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop';",
    'Add-Type -AssemblyName System.Security;',
    `$entropy = [Text.Encoding]::ASCII.GetBytes('${ENTROPY}');`,
    `$items = ConvertFrom-Json -InputObject '${json}';`,
    "$items | ForEach-Object { try { $bytes = [Convert]::FromBase64String($_); $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); Write-Output (ConvertTo-Json -Compress -InputObject ([Text.Encoding]::UTF8.GetString($plain))) } catch { Write-Output 'null' } }",
  ].join(' ')
}

// 每行是一个 JSON 字符串（明文 JSON）或 null；坏数据只影响对应条目。
export function parseDpapiOutput(stdout: string, count: number): (string | null)[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const result: (string | null)[] = []
  for (let i = 0; i < count; i++) {
    const line = lines[i]
    if (line === undefined) {
      result.push(null)
      continue
    }
    try {
      const value: unknown = JSON.parse(line)
      result.push(typeof value === 'string' ? value : null)
    } catch {
      result.push(null)
    }
  }
  return result
}

async function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    const timer = setTimeout(() => child.kill(), POWERSHELL_TIMEOUT_MS)
    const finish = (): void => {
      clearTimeout(timer)
      resolve(stdout)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk
    })
    // stderr 可能回显脚本片段，直接丢弃以免阻塞，也不进日志。
    child.stderr?.resume()
    child.stdin?.on('error', () => {
      // 子进程提前退出时写入会 EPIPE，忽略即可。
    })
    child.on('error', finish)
    child.on('close', finish)
    child.stdin?.end(script)
  })
}

export type DpapiOptions = {
  platform?: NodeJS.Platform
}

// 返回 旧连接 id → 明文 JSON 字符串（失败为 null）；非 Windows 无 DPAPI，返回空。
export async function decryptLegacySecrets(
  entries: Readonly<Record<string, string>>,
  options: DpapiOptions = {}
): Promise<Record<string, string | null>> {
  if ((options.platform ?? process.platform) !== 'win32') return {}
  const keys = Object.keys(entries)
  if (keys.length === 0) return {}
  const script = buildDpapiScript(keys.map((key) => entries[key] ?? ''))
  const stdout = await runPowerShell(script)
  const plaintexts = parseDpapiOutput(stdout, keys.length)
  const result: Record<string, string | null> = {}
  keys.forEach((key, index) => {
    result[key] = plaintexts[index] ?? null
  })
  return result
}
