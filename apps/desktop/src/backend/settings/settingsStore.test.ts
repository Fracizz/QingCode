import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '../../shared/backendApi'
import { defaultAppSettings, sanitizeAppSettings } from './appSettings'
import { readAppSettings, writeAppSettings } from './settingsStore'

let userData = ''

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'qn-app-settings-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const sample = (): AppSettings =>
  sanitizeAppSettings({
    general: { sendKey: 'ctrlEnter', autoConnectLast: true, defaultAgent: 'claude', density: 'compact' },
    agents: { local: { codex: { enabled: false, path: 'C:\\bin\\codex.exe' } } },
  })

describe('settingsStore 文件 IO', () => {
  it('文件不存在时返回默认值', async () => {
    expect(await readAppSettings(userData)).toEqual(defaultAppSettings())
  })

  it('原子写入后可读回，且不残留 .tmp', async () => {
    await writeAppSettings(userData, sample())
    expect(await readAppSettings(userData)).toEqual(sample())
    const text = await readFile(join(userData, 'settings.json'), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ general: { sendKey: 'ctrlEnter' } })
    await expect(readFile(join(userData, 'settings.json.tmp'), 'utf8')).rejects.toThrow()
  })

  it('损坏的 JSON 回退默认值，未知字段在写入前被丢弃', async () => {
    await writeFile(join(userData, 'settings.json'), '{not json', 'utf8')
    expect(await readAppSettings(userData)).toEqual(defaultAppSettings())

    await writeAppSettings(userData, {
      ...sample(),
      general: { ...sample().general, accentColor: 'pink' },
    } as AppSettings)
    const text = await readFile(join(userData, 'settings.json'), 'utf8')
    expect(text).not.toContain('accentColor')
  })

  it('可重复写入覆盖旧值', async () => {
    await writeAppSettings(userData, sample())
    await writeAppSettings(userData, defaultAppSettings())
    expect(await readAppSettings(userData)).toEqual(defaultAppSettings())
  })
})
