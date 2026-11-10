import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types'
import * as projectSettings from '../projectSettings'
import { planTerminalConnectionEvent } from './terminalShellLifecycle'
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_GLOBAL_SETTINGS_TEXT, DEFAULT_PROJECT_SETTINGS_TEXT, formatSettings, parseSettingsText } from '../projectSettings'
import { mergeSettings } from '../autoSaveSettings'
import {
  PERSIST_LOCAL_SESSIONS_KEY,
  dropLegacyProjectPersistLocalOverride,
  flipLegacyPersistLocalDefault,
  parseTerminalPersistLocalSessions,
  readTerminalPersistLocalSessions,
  loadScopedTerminalPersistLocalSessions,
} from './terminalPersistLocalSettings'

describe('terminal.integrated.persistLocalSessions', () => {
  it('hosts new terminals by default, including settings files from before the key existed', () => {
    expect(DEFAULT_GLOBAL_SETTINGS[PERSIST_LOCAL_SESSIONS_KEY]).toBe(true)
    for (const value of [true, undefined, null, 'true', 'false', 1]) {
      expect(parseTerminalPersistLocalSessions(value)).toBe(true)
    }
    expect(readTerminalPersistLocalSessions({})).toBe(true)
    expect(readTerminalPersistLocalSessions(parseSettingsText('{ version: 1, custom: {} }'))).toBe(true)
  })

  it('keeps an explicit opt-out and honors workspace overrides', () => {
    expect(parseTerminalPersistLocalSessions(false)).toBe(false)
    const enabled = parseSettingsText('{ "terminal.integrated.persistLocalSessions": true }')
    const disabled = parseSettingsText('{ "terminal.integrated.persistLocalSessions": false }')
    const inherit = parseSettingsText('{ version: 1, custom: {} }', 'project')
    expect(readTerminalPersistLocalSessions(mergeSettings(enabled, inherit))).toBe(true)
    expect(readTerminalPersistLocalSessions(mergeSettings(disabled, inherit))).toBe(false)
    expect(readTerminalPersistLocalSessions(mergeSettings(enabled, disabled))).toBe(false)
    expect(readTerminalPersistLocalSessions(mergeSettings(disabled, enabled))).toBe(true)
  })

  it('enables hosting in the global template and inherits it in the workspace template', () => {
    const global = parseSettingsText(DEFAULT_GLOBAL_SETTINGS_TEXT)
    const workspace = parseSettingsText(DEFAULT_PROJECT_SETTINGS_TEXT, 'project')
    expect(global[PERSIST_LOCAL_SESSIONS_KEY]).toBe(true)
    expect(workspace[PERSIST_LOCAL_SESSIONS_KEY]).toBeUndefined()
    expect(readTerminalPersistLocalSessions(mergeSettings(global, workspace))).toBe(true)
    expect(readTerminalPersistLocalSessions(mergeSettings({ ...global, [PERSIST_LOCAL_SESSIONS_KEY]: false }, workspace))).toBe(false)
    for (const text of [DEFAULT_GLOBAL_SETTINGS_TEXT, DEFAULT_PROJECT_SETTINGS_TEXT]) {
      expect(text).toContain('不得删除注释')
      expect(text).toMatch(/\/\/ terminal\.integrated\.persistLocalSessions：[^\n]*默认 true/)
    }
  })
})

describe('local hosting settings inheritance', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([true, false])('preserves an explicit workspace override when saving JSON5 (%s)', enabled => {
    const settings = parseSettingsText(`{ "${PERSIST_LOCAL_SESSIONS_KEY}": ${enabled} }`, 'project')
    const saved = formatSettings(settings, 'project')
    expect(parseSettingsText(saved, 'project')[PERSIST_LOCAL_SESSIONS_KEY]).toBe(enabled)
    expect(saved).toContain('不得删除注释')
  })

  it.each([true, false])('shows the inherited user preference in project settings (%s)', async enabled => {
    vi.spyOn(projectSettings, 'loadGlobalSettings').mockResolvedValue({
      version: 1, custom: {}, [PERSIST_LOCAL_SESSIONS_KEY]: enabled,
    })
    vi.spyOn(projectSettings, 'loadProjectSettings').mockResolvedValue({ version: 1, custom: {} })
    const project: Project = { id: 'p1', name: 'app', path: 'D:/work/app' }

    expect(await loadScopedTerminalPersistLocalSessions('project', project)).toBe(enabled)
  })
})

describe('legacy default migration', () => {
  it('flips the false the old template wrote, and nothing else', () => {
    const legacy = { version: 1, custom: {}, [PERSIST_LOCAL_SESSIONS_KEY]: false }
    expect(flipLegacyPersistLocalDefault(legacy)).toBe(true)
    expect(legacy[PERSIST_LOCAL_SESSIONS_KEY]).toBe(true)
    for (const value of [true, undefined]) {
      const settings = { version: 1, custom: {}, [PERSIST_LOCAL_SESSIONS_KEY]: value }
      expect(flipLegacyPersistLocalDefault(settings)).toBe(false)
      expect(settings[PERSIST_LOCAL_SESSIONS_KEY]).toBe(value)
    }
  })

  it('drops the legacy workspace false so the workspace inherits the user setting', () => {
    const legacy = { version: 1, custom: {}, [PERSIST_LOCAL_SESSIONS_KEY]: false }
    expect(dropLegacyProjectPersistLocalOverride(legacy)).toBe(true)
    expect(PERSIST_LOCAL_SESSIONS_KEY in legacy).toBe(false)
    const saved = parseSettingsText(formatSettings(legacy, 'project'), 'project')
    expect(saved[PERSIST_LOCAL_SESSIONS_KEY]).toBeUndefined()
    const explicit = { version: 1, custom: {}, [PERSIST_LOCAL_SESSIONS_KEY]: true }
    expect(dropLegacyProjectPersistLocalOverride(explicit)).toBe(false)
    expect(explicit[PERSIST_LOCAL_SESSIONS_KEY]).toBe(true)
  })
})

describe('local host connection notices', () => {
  const local = { status: 'running' as const, connectionId: '__local__' }

  it('does not talk about SSH and stays quiet on repeated attempts', () => {
    expect(planTerminalConnectionEvent(local, { id: 'a', state: 'reconnecting', attempt: 1 })?.notice).toEqual({
      key: '本地终端宿主连接已断开，正在重新连接…',
    })
    expect(
      planTerminalConnectionEvent({ ...local, status: 'reconnecting' }, { id: 'a', state: 'reconnecting', attempt: 5 })
        ?.notice,
    ).toBeNull()
  })

  it('keeps SSH wording for remote terminals', () => {
    expect(
      planTerminalConnectionEvent({ status: 'running', connectionId: 'conn' }, { id: 'a', state: 'reconnecting' })?.notice,
    ).toEqual({ key: 'SSH 连接已断开，正在重新连接…' })
  })
})
