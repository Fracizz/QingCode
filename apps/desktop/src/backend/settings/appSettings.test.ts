import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_SIZES, FONT_SIZES_VERSION } from '../../shared/fontSizes'
import {
  defaultAppSettings,
  isSettingsAgent,
  isSettingsDensity,
  isSettingsSendKey,
  mergeAppSettings,
  sanitizeAgentPrefs,
  sanitizeAppSettings,
  sanitizeSettingsPatch,
} from './appSettings'

describe('defaultAppSettings', () => {
  it('给出完整的默认形状，每次返回独立对象', () => {
    const first = defaultAppSettings()
    expect(first).toEqual({
      general: {
        sendKey: 'enter',
        autoConnectLast: true,
        autoArchiveDays: 0,
        defaultAgent: 'codex',
        globalAccessMode: 'default',
        density: 'comfortable',
        theme: 'dark',
        ...DEFAULT_FONT_SIZES,
        fontSizesVersion: FONT_SIZES_VERSION,
      },
      agents: {},
    })
    first.general.sendKey = 'ctrlEnter'
    expect(defaultAppSettings().general.sendKey).toBe('enter')
  })

  it('枚举校验只放行列出的值', () => {
    expect(isSettingsSendKey('ctrlEnter')).toBe(true)
    expect(isSettingsSendKey('shiftEnter')).toBe(false)
    expect(isSettingsDensity('compact')).toBe(true)
    expect(isSettingsDensity('dense')).toBe(false)
    expect(isSettingsAgent('pi')).toBe(true)
    expect(isSettingsAgent('unknown')).toBe(false)
  })
})

describe('sanitizeAppSettings', () => {
  it('损坏/非对象输入回退默认值', () => {
    expect(sanitizeAppSettings(null)).toEqual(defaultAppSettings())
    expect(sanitizeAppSettings('oops')).toEqual(defaultAppSettings())
    expect(sanitizeAppSettings({ general: 1, agents: [] })).toEqual(defaultAppSettings())
  })

  it('丢弃未知字段、非法值回退、路径去掉首尾空白', () => {
    const result = sanitizeAppSettings({
      general: {
        sendKey: 'ctrlEnter',
        autoConnectLast: 'yes',
        defaultAgent: 'pi',
        globalAccessMode: 'fullAccess',
        density: 'compact',
        theme: 'light',
        unknown: 1,
      },
      agents: {
        local: {
          codex: { enabled: false, path: '  C:\\bin\\codex.exe  ', configDir: ' D:\\codex-home ', junk: 1 },
          claude: { enabled: true, configDir: 'D:\\claude-home' },
          pi: { enabled: true, configDir: 'D:\\should-be-dropped', path: '/usr/bin/pi' },
          other: { enabled: true },
        },
        'ssh-1': null,
      },
    })
    expect(result.general).toEqual({
      sendKey: 'ctrlEnter',
      autoConnectLast: true,
      autoArchiveDays: 0,
      defaultAgent: 'pi',
      globalAccessMode: 'default',
      density: 'compact',
      theme: 'light',
      ...DEFAULT_FONT_SIZES,
      fontSizesVersion: FONT_SIZES_VERSION,
    })
    expect(sanitizeAppSettings({ general: { theme: 'sepia' } }).general.theme).toBe('dark')
    expect(result.agents.local).toEqual({
      codex: { enabled: false, path: 'C:\\bin\\codex.exe', configDir: 'D:\\codex-home' },
      claude: { enabled: true, configDir: 'D:\\claude-home' },
      pi: { enabled: true, path: '/usr/bin/pi' },
    })
    expect(JSON.stringify(result)).not.toContain('should-be-dropped')
    expect(JSON.stringify(result)).not.toContain('junk')
    expect(result.agents['ssh-1']).toBeUndefined()
  })

  it('跳过原型污染键，且不与输入共享引用', () => {
    const raw = JSON.parse(
      '{"agents":{"__proto__":{"codex":{"enabled":false}},"constructor":{"claude":{"enabled":false}}}}',
    ) as unknown
    const result = sanitizeAppSettings(raw)
    expect(result.agents['__proto__']).toBeUndefined()
    expect(result.agents['constructor']).toBeUndefined()
    expect(({} as Record<string, unknown>).enabled).toBeUndefined()
    const source = { agents: { local: { codex: { enabled: false, path: '/bin/codex' } } } }
    const copy = sanitizeAppSettings(source)
    source.agents.local.codex!.enabled = true
    expect(copy.agents.local?.codex?.enabled).toBe(false)
    expect(sanitizeAgentPrefs('pi', { configDir: '/x' })).toEqual({ enabled: true })
  })
})

describe('sanitizeSettingsPatch', () => {
  it('只保留白名单字段，空字符串用于清空路径', () => {
    const patch = sanitizeSettingsPatch({
      general: { sendKey: 'ctrlEnter', density: 'bogus', theme: 'gray' },
      agents: {
        local: {
          codex: { enabled: false, path: '', configDir: '  D:\\home  ', extra: 1 },
          pi: { enabled: true, configDir: 'ignored' },
          nope: { enabled: true },
        },
      },
      extra: true,
    })
    expect(patch).toEqual({
      general: { sendKey: 'ctrlEnter', theme: 'gray' },
      agents: {
        local: {
          codex: { enabled: false, path: '', configDir: 'D:\\home' },
          pi: { enabled: true },
        },
      },
    })
  })

  it('非对象或含无效字段的补丁收敛为空对象', () => {
    expect(sanitizeSettingsPatch(undefined)).toEqual({})
    expect(sanitizeSettingsPatch([])).toEqual({})
    expect(sanitizeSettingsPatch({ general: { sendKey: 1 }, agents: { __proto__: { codex: { enabled: false } } } })).toEqual({})
  })
})

describe('mergeAppSettings', () => {
  it('保存有效的归档期限并忽略非法补丁', () => {
    const enabled = mergeAppSettings(defaultAppSettings(), { general: { autoArchiveDays: 90 } })
    expect(enabled.general.autoArchiveDays).toBe(90)
    expect(sanitizeSettingsPatch({ general: { autoArchiveDays: '90' } })).toEqual({})
    expect(mergeAppSettings(enabled, { general: { autoArchiveDays: 0 } }).general.autoArchiveDays).toBe(0)
  })

  it('general 与 agent 偏好分别深合并，不覆盖未提交的字段', () => {
    const current = sanitizeAppSettings({
      general: { sendKey: 'enter', autoConnectLast: true, defaultAgent: 'claude', density: 'comfortable' },
      agents: {
        local: { codex: { enabled: false, path: 'C:\\codex.exe', configDir: 'C:\\cfg' } },
        'ssh-1': { claude: { enabled: true, path: '/opt/claude' } },
      },
    })
    const next = mergeAppSettings(current, {
      general: { density: 'compact', globalAccessMode: 'restricted' },
      agents: {
        local: { codex: { path: 'D:\\new\\codex.exe' } },
        'ssh-2': { pi: { enabled: true } },
      },
    })
    expect(next.general).toEqual({
      sendKey: 'enter',
      autoConnectLast: true,
      autoArchiveDays: 0,
      defaultAgent: 'claude',
      globalAccessMode: 'restricted',
      density: 'compact',
      theme: 'dark',
      ...DEFAULT_FONT_SIZES,
      fontSizesVersion: FONT_SIZES_VERSION,
    })
    expect(next.agents.local?.codex).toEqual({
      enabled: false,
      path: 'D:\\new\\codex.exe',
      configDir: 'C:\\cfg',
    })
    expect(next.agents['ssh-1']?.claude).toEqual({ enabled: true, path: '/opt/claude' })
    expect(next.agents['ssh-2']?.pi).toEqual({ enabled: true })
    // 原对象不被改动（乐观更新失败时可安全回滚）。
    expect(current.general.density).toBe('comfortable')
    expect(current.agents.local?.codex?.path).toBe('C:\\codex.exe')
  })

  it('空字符串清空路径；未知字段与 pi 的 configDir 不落盘', () => {
    const current = sanitizeAppSettings({
      agents: { local: { codex: { enabled: false, path: 'C:\\codex.exe' }, pi: { enabled: true } } },
    })
    const next = mergeAppSettings(current, {
      agents: {
        local: {
          codex: { path: '' },
          pi: { configDir: 'C:\\pi-home', unknown: 1 },
        },
      },
    } as never)
    expect(next.agents.local?.codex).toEqual({ enabled: false })
    expect(next.agents.local?.pi).toEqual({ enabled: true })
  })

  it('合并不合法补丁时保持原值', () => {
    const current = defaultAppSettings()
    expect(mergeAppSettings(current, { general: { sendKey: 'bad' } } as never)).toEqual(defaultAppSettings())
    expect(mergeAppSettings(current, {})).toEqual(defaultAppSettings())
  })

  it('字号独立保存，旧设置和无效字号使用默认值', () => {
    const current = sanitizeAppSettings({ general: { chatFontSize: 18, composerFontSize: -1 } })
    expect(current.general).toMatchObject({ ...DEFAULT_FONT_SIZES, chatFontSize: 18 })
    const next = mergeAppSettings(current, {
      general: { editorFontSize: 16, chatFontSize: 100 },
    })
    expect(next.general).toMatchObject({ ...DEFAULT_FONT_SIZES, chatFontSize: 18, editorFontSize: 16 })
  })
})
