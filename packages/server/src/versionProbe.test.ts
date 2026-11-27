import { describe, expect, it } from 'vitest'
import { parseVersion, readVersionAsync } from './versionProbe'

describe('readVersionAsync', () => {
  it('从输出中提取版本号', async () => {
    const version = await readVersionAsync({ command: process.execPath, args: ['-e', 'console.log("tool 1.2.3")', '--'] })
    expect(version).toBe('1.2.3')
  })

  it('程序不存在时返回 unknown', async () => {
    await expect(readVersionAsync({ command: '/definitely/missing/agent-cli' })).resolves.toBe('unknown')
  })

  it('超时后返回已读到的输出解析结果', async () => {
    const started = Date.now()
    const version = await readVersionAsync({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)', '--'] }, 200)
    expect(version).toBe('unknown')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('parseVersion 无版本号时返回 unknown', () => {
    expect(parseVersion('no version')).toBe('unknown')
  })
})
