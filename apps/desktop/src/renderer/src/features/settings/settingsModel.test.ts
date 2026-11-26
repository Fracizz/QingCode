import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_SIZES } from '../../../../shared/fontSizes'
import {
  DEFAULT_AGENT_OPTIONS,
  DENSITY_OPTIONS,
  SEND_KEY_OPTIONS,
  SETTINGS_AGENT_INFO,
  SETTINGS_SECTIONS,
  SETTING_ITEMS,
  THEME_OPTIONS,
  agentPrefs,
  defaultAppSettings,
  densityAttribute,
  filterSettings,
  isSettingsSection,
  mergeAppSettings,
  sanitizeAppSettings,
  sanitizeSettingsPatch,
} from './settingsModel'

describe('默认设置与白名单', () => {
  it('默认值完整且各次独立', () => {
    const first = defaultAppSettings()
    expect(first.general).toEqual({
      sendKey: 'enter',
      autoConnectLast: true,
      defaultAgent: 'codex',
      density: 'comfortable',
      ...DEFAULT_FONT_SIZES,
    })
    first.agents.local = { codex: { enabled: false } }
    expect(defaultAppSettings().agents).toEqual({})
  })

  it('非法输入回退默认，字段白名单与 pi 的 configDir 限制生效', () => {
    expect(sanitizeAppSettings(null)).toEqual(defaultAppSettings())
    const result = sanitizeAppSettings({
      general: { sendKey: 'bad', density: 'compact', defaultAgent: 'pi', theme: 'light' },
      agents: {
        local: {
          codex: { enabled: false, path: '  C:\\bin\\codex.exe  ', configDir: ' D:\\home ', junk: 1 },
          pi: { enabled: true, configDir: 'ignored' },
          other: { enabled: true },
        },
        __proto__: { codex: { enabled: false } },
      },
    })
    expect(result.general).toEqual({
      sendKey: 'enter',
      autoConnectLast: true,
      defaultAgent: 'pi',
      density: 'compact',
      ...DEFAULT_FONT_SIZES,
    })
    expect(result.agents.local?.codex).toEqual({
      enabled: false,
      path: 'C:\\bin\\codex.exe',
      configDir: 'D:\\home',
    })
    expect(result.agents.local?.pi).toEqual({ enabled: true })
    expect(JSON.stringify(result)).not.toContain('junk')
    expect(result.agents['__proto__']).toBeUndefined()
  })

  it('补丁只保留已知字段，空字符串用于清空路径', () => {
    expect(sanitizeSettingsPatch({ general: { density: 'compact', theme: 'light' } })).toEqual({
      general: { density: 'compact' },
    })
    expect(sanitizeSettingsPatch({ agents: { local: { codex: { path: '' } } } })).toEqual({
      agents: { local: { codex: { path: '' } } },
    })
    expect(sanitizeSettingsPatch('oops')).toEqual({})
  })

  it('深合并保留未提交的字段，且能清空路径', () => {
    const current = sanitizeAppSettings({
      general: { sendKey: 'enter', autoConnectLast: true, defaultAgent: 'claude' },
      agents: { local: { codex: { enabled: false, path: 'C:\\codex.exe', configDir: 'C:\\cfg' } } },
    })
    const next = mergeAppSettings(current, {
      general: { density: 'compact' },
      agents: { local: { codex: { path: 'D:\\codex.exe' } }, 'ssh-1': { pi: { enabled: true } } },
    })
    expect(next.general.autoConnectLast).toBe(true)
    expect(next.agents.local?.codex).toEqual({
      enabled: false,
      path: 'D:\\codex.exe',
      configDir: 'C:\\cfg',
    })
    expect(next.agents['ssh-1']?.pi).toEqual({ enabled: true })
    expect(current.agents.local?.codex?.path).toBe('C:\\codex.exe')

    const cleared = mergeAppSettings(next, { agents: { local: { codex: { path: '' } } } as never })
    expect(cleared.agents.local?.codex?.path).toBeUndefined()
  })

  it('未配置的 agent 默认启用', () => {
    expect(agentPrefs(defaultAppSettings(), 'local', 'claude')).toEqual({ enabled: true })
    expect(densityAttribute('compact')).toBe('compact')
  })
})

describe('界面元数据与合规文案', () => {
  it('三个 Agent 的登录说明是静态文案，且包含合规提示', () => {
    expect(SETTINGS_AGENT_INFO.map((item) => item.id)).toEqual(['codex', 'claude', 'pi'])
    expect(SETTINGS_AGENT_INFO[0]?.loginCommand).toBe('codex login')
    expect(SETTINGS_AGENT_INFO[0]?.configEnv).toBe('CODEX_HOME')
    expect(SETTINGS_AGENT_INFO[1]?.loginCommand).toBe('claude')
    expect(SETTINGS_AGENT_INFO[1]?.loginSuffix).toContain('/login')
    expect(SETTINGS_AGENT_INFO[1]?.loginSuffix).toContain('API key')
    expect(SETTINGS_AGENT_INFO[1]?.notes.join(' ')).toContain('订阅登录仅限本人自用，推荐 API key')
    expect(SETTINGS_AGENT_INFO[1]?.configEnv).toBe('CLAUDE_CONFIG_DIR')
    expect(SETTINGS_AGENT_INFO[2]?.loginCommand).toBe('pi')
    expect(SETTINGS_AGENT_INFO[2]?.notes.join(' ')).toContain('pi 不经审批直接执行工具')
    expect(SETTINGS_AGENT_INFO.every((item) => item.notes.join(' ').includes('不保存任何凭据') || item.id === 'pi')).toBe(true)
  })

  it('表单选项覆盖所有枚举值，浅色主题置灰', () => {
    expect(SEND_KEY_OPTIONS.map((item) => item.value)).toEqual(['enter', 'ctrlEnter'])
    expect(DENSITY_OPTIONS.map((item) => item.value)).toEqual(['comfortable', 'compact'])
    expect(DEFAULT_AGENT_OPTIONS.map((item) => item.value)).toEqual(['codex', 'claude', 'pi'])
    expect(THEME_OPTIONS.find((item) => item.value === 'light')?.disabled).toBe(true)
  })

  it('分类与设置项一一对应，section 校验只认已知 id', () => {
    expect(SETTINGS_SECTIONS.map((item) => item.id)).toEqual([
      'general', 'agents', 'connections', 'mobile', 'about',
    ])
    expect(new Set(SETTING_ITEMS.map((item) => item.id)).size).toBe(SETTING_ITEMS.length)
    expect(SETTING_ITEMS.every((item) => SETTINGS_SECTIONS.some((s) => s.id === item.section))).toBe(true)
    expect(isSettingsSection('agents')).toBe(true)
    expect(isSettingsSection('other')).toBe(false)
    expect(isSettingsSection(undefined)).toBe(false)
  })
})

describe('filterSettings', () => {
  it('空查询返回全部分类与设置项', () => {
    const result = filterSettings('   ')
    expect(result.empty).toBe(false)
    expect(result.itemIds).toHaveLength(SETTING_ITEMS.length)
    expect(result.sections.map((section) => section.id)).toEqual(SETTINGS_SECTIONS.map((s) => s.id))
  })

  it('按标题或关键字匹配，多关键字按 AND 语义', () => {
    expect(filterSettings('快捷键').itemIds).toEqual(['sendKey'])
    expect(filterSettings('ctrl+enter').itemIds).toEqual(['sendKey'])
    expect(filterSettings('手机 证书').itemIds).toEqual(['mobile'])
    expect(filterSettings('codex_home').itemIds).toEqual(['agents'])
    expect(filterSettings('字体大小 终端').itemIds).toEqual(['terminalFontSize'])
    expect(filterSettings('agent codex').sections.map((s) => s.id)).toContain('agents')
  })

  it('无匹配时给出空结果', () => {
    const result = filterSettings('完全不存在的关键词')
    expect(result.empty).toBe(true)
    expect(result.sections).toEqual([])
    expect(result.itemIds).toEqual([])
  })
})
