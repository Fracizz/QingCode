import { describe, expect, it } from 'vitest'
import { archivedThreadKey } from './agents'
import { mobileTurnFits, queuedInput, restoreQueues, serializeQueues, type QueuedSend } from './queuedSends'
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
  it('重开时保留未发送项及附件，明确标记已发出但未确认的项', () => {
    const raw = serializeQueues({ [key]: [item, { ...item, id: 'in-flight', sending: true, accessMode: 'auto' }] }, [conn])
    const [first, inFlight] = restoreQueues(raw, [conn], {})[key] ?? []
    expect(first).toMatchObject({ ...item, sending: false, error: '已恢复排队消息，等待继续发送' })
    expect(inFlight).toMatchObject({ id: 'in-flight', accessMode: 'auto', sending: false, error: expect.stringContaining('未确认') })
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
