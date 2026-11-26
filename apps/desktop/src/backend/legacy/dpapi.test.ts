import { spawnSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDpapiScript, decryptLegacySecrets, parseDpapiOutput } from './dpapi'

function protect(plain: string): string {
  const script = [
    'Add-Type -AssemblyName System.Security',
    "$entropy = [Text.Encoding]::ASCII.GetBytes('qingcode-ssh-secret-v1')",
    `$plain = [Text.Encoding]::UTF8.GetBytes('${plain.replace(/'/g, "''")}')`,
    '$bytes = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($bytes)',
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: script,
    encoding: 'utf8',
  })
  if (result.status !== 0 || result.stdout.trim() === '') {
    throw new Error('PowerShell Protect 失败，无法构造测试密文')
  }
  return result.stdout.trim()
}

describe('buildDpapiScript', () => {
  it('生成单行脚本，带熵、CurrentUser 与全部密文，且转义单引号', () => {
    const script = buildDpapiScript(['YQ==', "Y')=="])
    expect(script).not.toContain('\n')
    expect(script).toContain('Add-Type -AssemblyName System.Security')
    expect(script).toContain('qingcode-ssh-secret-v1')
    expect(script).toContain('ProtectedData]::Unprotect')
    expect(script).toContain('DataProtectionScope]::CurrentUser')
    expect(script).toContain('YQ==')
    expect(script).toContain("Y'')==")
    expect(script).toContain('ConvertFrom-Json')
  })
})

describe('parseDpapiOutput', () => {
  it('逐行解析 JSON 字符串，坏行/缺行补 null，多余行忽略', () => {
    const stdout = '"{\\"password\\":\\"p\\"}"\r\nnull\r\nnot-json\r\n'
    expect(parseDpapiOutput(stdout, 5)).toEqual(['{"password":"p"}', null, null, null, null])
    expect(parseDpapiOutput('"a"\n"b"\n"c"', 2)).toEqual(['a', 'b'])
    expect(parseDpapiOutput('', 1)).toEqual([null])
  })
})

describe('decryptLegacySecrets', () => {
  it('非 Windows 返回空', async () => {
    expect(await decryptLegacySecrets({ c1: 'YQ==' }, { platform: 'linux' })).toEqual({})
  })

  it('空输入不启动 PowerShell', async () => {
    expect(await decryptLegacySecrets({})).toEqual({})
  })
})

describe.skipIf(process.platform !== 'win32')('DPAPI 往返（仅 Windows）', () => {
  // PowerShell 冷启动约 2-3 秒，密文只在 beforeAll 构造一次。
  let plain = ''
  let good = ''
  beforeAll(() => {
    plain = JSON.stringify({ password: 'p@ss', passphrase: 'phrase' })
    good = protect(plain)
  }, 30_000)

  it('能解密旧版 DPAPI 密文', async () => {
    const result = await decryptLegacySecrets({ c1: good })
    expect(result['c1']).toBe(plain)
  }, 30_000)

  it('坏密文只影响对应条目，且不退化为明文泄漏', async () => {
    const result = await decryptLegacySecrets({ c1: 'bogus!!', c2: good })
    expect(result['c1']).toBeNull()
    expect(result['c2']).toBe(plain)
  }, 30_000)
})
