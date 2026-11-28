import { expect, it } from 'vitest'
import { accessPreferenceKey, accessSelectionOf, leavePlanPreference, restoreAccessPrefs, selectAccess } from './accessPrefs'
import { archivedThreadKey } from './agents'
import type { Connection } from './types'

const connection: Connection = {
  id: 'desktop', name: '电脑', host: 'localhost', port: 38500,
  fp: 'ab'.repeat(32), token: 'test', desktopName: '电脑', createdAt: 0,
}

it('恢复同一电脑和会话的权限，保留显式选择的 Agent 默认和总控继承', () => {
  const address = { desktopId: connection.id, targetId: 'local', agent: 'codex', threadId: 'thread' } as const
  const key = accessPreferenceKey(address, connection.fp)
  const readOnly = accessPreferenceKey({ ...address, threadId: 'read-only-thread' }, connection.fp)
  const inherited = accessPreferenceKey({ ...address, threadId: 'inherited-thread' }, connection.fp)
  const raw = JSON.stringify({
    [key]: 'default',
    [readOnly]: 'auto',
    [inherited]: 'inherit',
    [accessPreferenceKey({ ...address, agent: 'claude' }, connection.fp)]: 'plan',
    [accessPreferenceKey({ ...address, threadId: 'another' }, 'cd'.repeat(32))]: 'fullAccess',
    malformed: 'fullAccess',
  })
  expect(restoreAccessPrefs(raw, [connection], {})).toEqual({ [key]: 'default', [readOnly]: 'auto', [inherited]: 'inherit' })
  const archived = archivedThreadKey(connection.id, address.targetId, { agent: address.agent, id: address.threadId })
  expect(restoreAccessPrefs(raw, [connection], { [archived]: true })).toEqual({ [readOnly]: 'auto', [inherited]: 'inherit' })
})

it('计划模式连同返回档位保存和恢复，不支持计划模式的 Agent 丢弃', () => {
  const claude = accessPreferenceKey({ desktopId: connection.id, targetId: 'local', agent: 'claude', threadId: 'c' }, connection.fp)
  const codex = accessPreferenceKey({ desktopId: connection.id, targetId: 'local', agent: 'codex', threadId: 't' }, connection.fp)
  const planned = selectAccess(selectAccess({ [claude]: 'auto' }, claude, 'plan', 'exit-1'), claude, 'plan', 'exit-2')
  expect(planned[claude]).toEqual({ mode: 'plan', back: 'auto', seenExit: 'exit-1' })
  expect(accessSelectionOf(planned[claude])).toBe('plan')
  expect(leavePlanPreference(planned, claude)).toEqual({ [claude]: 'auto' })
  expect(leavePlanPreference(planned, codex)).toBe(planned)
  // 没选过档位时回到跟随总控。
  expect(selectAccess({}, claude, 'plan')[claude]).toEqual({ mode: 'plan', back: 'inherit' })
  const raw = JSON.stringify({ ...planned, [codex]: { mode: 'plan', back: 'default' } })
  expect(restoreAccessPrefs(raw, [connection], {})).toEqual(planned)
})
