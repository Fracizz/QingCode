import { describe, expect, it } from 'vitest'
import {
  parseSshAgentEnabled,
  readSshAgentEnabled,
  SSH_AGENT_ENABLED_KEY,
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
})
