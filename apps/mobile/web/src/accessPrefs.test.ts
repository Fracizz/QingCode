import { expect, it } from 'vitest'
import { accessPreferenceKey, restoreAccessPrefs } from './accessPrefs'
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
