import { describe, expect, it } from 'vitest'
import { parseUnreadChange, unreadKeysFromList } from './unreadSync'

describe('共享未读', () => {
  it('把目标机未读列表转成本地会话键，旧 daemon 返回 null', () => {
    expect(unreadKeysFromList({ threads: [{ agent: 'codex', threadId: 'a', at: 1 }, { agent: 'x', threadId: 'b' }, { agent: 'pi' }] }))
      .toEqual(['codex:a'])
    expect(unreadKeysFromList({})).toBeNull()
  })

  it('只接受完整的未读事件', () => {
    expect(parseUnreadChange({ agent: 'claude', threadId: 't', unread: true })).toEqual({ agent: 'claude', threadId: 't', unread: true })
    expect(parseUnreadChange({ agent: 'claude', threadId: '', unread: true })).toBeNull()
    expect(parseUnreadChange({ agent: 'claude', threadId: 't' })).toBeNull()
  })
})
