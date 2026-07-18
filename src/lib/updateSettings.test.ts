import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UPDATE_SETTINGS,
  isVersionSkipped,
  parseCheckOnStartup,
  parseSkippedVersion,
  readUpdateSettings,
  UPDATE_CHECK_ON_STARTUP_KEY,
  UPDATE_SKIPPED_VERSION_KEY,
} from './updateSettings'

describe('updateSettings', () => {
  it('defaults checkOnStartup to true', () => {
    expect(parseCheckOnStartup(undefined)).toBe(true)
    expect(DEFAULT_UPDATE_SETTINGS.checkOnStartup).toBe(true)
  })

  it('parses boolean checkOnStartup', () => {
    expect(parseCheckOnStartup(false)).toBe(false)
    expect(parseCheckOnStartup(true)).toBe(true)
  })

  it('parses skipped version and strips v prefix', () => {
    expect(parseSkippedVersion('v0.1.4')).toBe('0.1.4')
    expect(parseSkippedVersion('  ')).toBeNull()
    expect(parseSkippedVersion(1)).toBeNull()
  })

  it('reads settings keys', () => {
    expect(
      readUpdateSettings({
        [UPDATE_CHECK_ON_STARTUP_KEY]: false,
        [UPDATE_SKIPPED_VERSION_KEY]: 'v1.2.3',
      }),
    ).toEqual({ checkOnStartup: false, skippedVersion: '1.2.3' })
  })

  it('matches skipped versions', () => {
    expect(isVersionSkipped('0.1.4', '0.1.4')).toBe(true)
    expect(isVersionSkipped('v0.1.4', '0.1.4')).toBe(true)
    expect(isVersionSkipped('0.1.5', '0.1.4')).toBe(false)
    expect(isVersionSkipped('0.1.4', null)).toBe(false)
  })
})
