import { describe, expect, it } from 'vitest'
import { planTerminalConnectionEvent } from './terminalShellLifecycle'
import {
  PERSIST_LOCAL_SESSIONS_KEY,
  parseTerminalPersistLocalSessions,
  readTerminalPersistLocalSessions,
} from './terminalPersistLocalSettings'

describe('terminal.integrated.persistLocalSessions', () => {
  it('hosts local terminals by default, including settings from before the option existed', () => {
    expect(parseTerminalPersistLocalSessions(true)).toBe(true)
    for (const value of [undefined, null, 'true', 'false', 1]) {
      expect(parseTerminalPersistLocalSessions(value)).toBe(true)
    }
    expect(readTerminalPersistLocalSessions({})).toBe(true)
    expect(readTerminalPersistLocalSessions({ [PERSIST_LOCAL_SESSIONS_KEY]: true })).toBe(true)
  })

  it('honors an explicit opt-out', () => {
    expect(parseTerminalPersistLocalSessions(false)).toBe(false)
    expect(readTerminalPersistLocalSessions({ [PERSIST_LOCAL_SESSIONS_KEY]: false })).toBe(false)
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
