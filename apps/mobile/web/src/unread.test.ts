import { describe, expect, it } from 'vitest'
import { parseUnreadChange, unreadKeysFromList } from './unread'

describe('共享未读', () => {
  it('解析目标机未读列表，旧 daemon 返回 null', () => {
    expect(unreadKeysFromList({ threads: [{ agent: 'claude', threadId: 't1', at: 1 }, { agent: 'x', threadId: 't2' }] }))
      .toEqual(new Set(['claude:t1']))
    expect(unreadKeysFromList(null)).toBeNull()
  })

  it('只接受完整的未读事件', () => {
    expect(parseUnreadChange({ agent: 'pi', threadId: 't', unread: false })).toEqual({ agent: 'pi', threadId: 't', unread: false })
    expect(parseUnreadChange({ agent: 'pi', threadId: 't' })).toBeNull()
  })
})
