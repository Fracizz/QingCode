import { describe, expect, it } from 'vitest'
import {
  parseSshAgentAutoDownload,
  parseSshAgentEnabled,
  parseSshAgentOfflineDir,
  readSshAgentAutoDownload,
  readSshAgentEnabled,
  readSshAgentOfflineDir,
  SSH_AGENT_AUTO_DOWNLOAD_KEY,
  SSH_AGENT_ENABLED_KEY,
  SSH_AGENT_OFFLINE_DIR_KEY,
} from '@/lib/sshAgentSettings'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'

describe('sshAgentSettings', () => {
  it('defaults on when unset', () => {
    expect(parseSshAgentEnabled(undefined)).toBe(true)
    expect(parseSshAgentEnabled(true)).toBe(true)
    expect(parseSshAgentEnabled(false)).toBe(false)
    expect(parseSshAgentEnabled('false')).toBe(true)
  })

  it('reads ssh.agent.enabled', () => {
    expect(readSshAgentEnabled(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
    expect(
      readSshAgentEnabled({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_AGENT_ENABLED_KEY]: false,
      }),
    ).toBe(false)
  })

  it('autoDownload defaults on and only accepts explicit true', () => {
    expect(parseSshAgentAutoDownload(undefined)).toBe(true)
    expect(parseSshAgentAutoDownload(null)).toBe(true)
    expect(parseSshAgentAutoDownload(false)).toBe(false)
    expect(parseSshAgentAutoDownload('true')).toBe(false)
    expect(parseSshAgentAutoDownload(true)).toBe(true)
    expect(readSshAgentAutoDownload(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
    expect(
      readSshAgentAutoDownload({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_AGENT_AUTO_DOWNLOAD_KEY]: true,
      }),
    ).toBe(true)
  })

  it('offlineDir is an empty local path unless explicitly set', () => {
    expect(parseSshAgentOfflineDir(undefined)).toBe('')
    expect(parseSshAgentOfflineDir('  ')).toBe('')
    expect(parseSshAgentOfflineDir('ssh://host/tmp/agents')).toBe('')
    expect(parseSshAgentOfflineDir('D:/agents')).toBe('D:/agents')
    expect(readSshAgentOfflineDir(DEFAULT_GLOBAL_SETTINGS)).toBe('')
    expect(
      readSshAgentOfflineDir({
        ...DEFAULT_GLOBAL_SETTINGS,
        [SSH_AGENT_OFFLINE_DIR_KEY]: '  D:/offline/agents  ',
      }),
    ).toBe('D:/offline/agents')
  })
})
