import { describe, expect, it } from 'vitest'
import { archivedThreadKey } from './agents'
import { applyRelayResult, mobileTurnFits, queuedInput, releaseRelayedSends, relayRequest, restoreQueues, serializeQueues, UNCONFIRMED_QUEUED_SEND, type QueuedSend } from './queuedSends'
import type { Connection } from './types'

const conn: Connection = {
  id: 'desktop', name: '电脑', host: 'localhost', port: 38500,
  fp: 'ab'.repeat(32), token: 'test', desktopName: '电脑', createdAt: 0,
}
const key = JSON.stringify([conn.id, 'local', 'codex', 'thread'])
const image = { type: 'image', url: 'data:image/png;base64,AA==' } as const
const item: QueuedSend = {
  id: 'first', text: '正文', annotations: [{ id: 'quote', quote: '上下文', comment: '备注' }],
  attachments: [image], delegate: false, overrides: {},
}

describe('手机发送队列', () => {
  it('重开时只恢复实际暂停原因和未确认的发送，清掉旧版通用恢复提示', () => {
    const raw = serializeQueues({ [key]: [
      { ...item, error: '已恢复排队消息，等待继续发送' },
      { ...item, id: 'waiting' },
      { ...item, id: 'in-flight', sending: true, accessMode: 'auto' },
      { ...item, id: 'paused', error: '上一轮未完成，队列已暂停' },
      { ...item, id: 'relay', relayPending: true },
    ] }, [conn])
    const [first, waiting, inFlight, paused, relay] = restoreQueues(raw, [conn], {})[key] ?? []
    expect(first).toMatchObject({ ...item, sending: false, error: undefined })
    expect(waiting?.error).toBeUndefined()
    expect(inFlight).toMatchObject({ id: 'in-flight', accessMode: 'auto', sending: false, error: UNCONFIRMED_QUEUED_SEND })
    expect(paused?.error).toBe('上一轮未完成，队列已暂停')
    expect(relay).toMatchObject({ relayPending: true, error: undefined })
    expect(restoreQueues(raw, [{ ...conn, fp: 'cd'.repeat(32) }], {})).toEqual({})
    const archived = archivedThreadKey(conn.id, 'local', { id: 'thread', agent: 'codex' })
    expect(restoreQueues(raw, [conn], { [archived]: true })).toEqual({})
  })

  it('修改正文保留引用和附件，按实际发送方式校验消息上限', () => {
    const input = queuedInput('codex', { ...item, text: '修订' })
    expect(input).toEqual([{ type: 'text', text: '> 上下文\n备注\n\n修订', text_elements: [] }, image])
    expect(mobileTurnFits('local', 'codex', 'thread', input, {}, 'turn')).toBe(true)
    expect(mobileTurnFits('local', 'codex', 'thread', [{ type: 'text', text: '字'.repeat(350_000), text_elements: [] }], {})).toBe(false)
  })
})

describe('锁屏交给电脑代发', () => {
  it('按手机直发的规则组装请求：默认权限走 codex.send，其余带上访问模式', () => {
    const plain = relayRequest('local', 'thread', 'codex', { ...item, overrides: { model: 'gpt', serviceTier: null } },
      { accessMode: 'default' }, false, 'client-1')
    expect(plain).toEqual({
      method: 'codex.send',
      params: { targetId: 'local', agent: 'codex', msg: { method: 'turn/start', params: {
        threadId: 'thread', input: queuedInput('codex', item), clientUserMessageId: 'client-1', model: 'gpt', serviceTier: null,
      } } },
    })
    const managed = relayRequest('local', 'thread', 'claude', item, { accessMode: 'auto', inheritAccess: false }, true, 'client-2')
    expect(managed).toMatchObject({ method: 'mobile.turn.start', params: { accessMode: 'auto', inheritAccess: false } })
    expect(() => relayRequest('local', 'thread', 'claude', item, { accessMode: 'auto' }, false, 'c')).toThrow('访问模式')
  })

  it('收回时去掉电脑已发出的消息，暂停原因落到队首；电脑丢失记录时标为未确认', () => {
    const list = [item, { ...item, id: 'second' }, { ...item, id: 'third' }]
    expect(applyRelayResult(list, ['first'], undefined).map((entry) => entry.id)).toEqual(['second', 'third'])
    expect(applyRelayResult(list, ['first', 'second'], '上一轮未完成，队列已暂停')[0])
      .toMatchObject({ id: 'third', error: '上一轮未完成，队列已暂停' })
    const relayed = [{ ...item, relayPending: true } as const, ...list.slice(1)]
    expect(releaseRelayedSends(relayed, true)).toEqual(list)
    expect(releaseRelayedSends(relayed, false)).toEqual([{ ...item, error: UNCONFIRMED_QUEUED_SEND }, ...list.slice(1)])
    const paused = [{ ...item, error: UNCONFIRMED_QUEUED_SEND }]
    expect(applyRelayResult(paused, [])).toBe(paused)
    expect(applyRelayResult(paused, [], '上一轮未完成，队列已暂停')).toBe(paused)
    expect(applyRelayResult(list, ['first', 'second', 'third'], undefined)).toEqual([])
    expect(applyRelayResult(list, [], undefined)).toBe(list)
  })
})
