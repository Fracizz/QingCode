import { describe, expect, it } from 'vitest'
import { planTerminalConnectionEvent } from './terminalShellLifecycle'
import {
  PERSIST_LOCAL_SESSIONS_KEY,
  parseTerminalPersistLocalSessions,
  readTerminalPersistLocalSessions,
} from './terminalPersistLocalSettings'

describe('terminal.integrated.persistLocalSessions', () => {
  it('is opt-in: only an explicit true enables hosting', () => {
    expect(parseTerminalPersistLocalSessions(true)).toBe(true)
    for (const value of [false, undefined, null, 'true', 1]) {
      expect(parseTerminalPersistLocalSessions(value)).toBe(false)
    }
    expect(readTerminalPersistLocalSessions({})).toBe(false)
    expect(readTerminalPersistLocalSessions({ [PERSIST_LOCAL_SESSIONS_KEY]: true })).toBe(true)
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
