import { describe, expect, it } from 'vitest'
import { PendingRequests } from './pendingRequests'

const request = { id: 'approval-1', method: 'item/commandExecution/requestApproval' }

describe('PendingRequests', () => {
  it('只有第一个响应生效', () => {
    const table = new PendingRequests()
    table.add('approval-1', request, 4)
    expect(table.size).toBe(1)
    expect(table.resolve('approval-1')).toEqual({ id: 'approval-1', seq: 4, msg: request })
    expect(table.resolve('approval-1')).toBeUndefined()
    expect(table.size).toBe(0)
  })

  it('数字 1 与字符串 1 是不同请求', () => {
    const table = new PendingRequests()
    table.add(1, request, 1)
    table.add('1', request, 2)
    expect(table.resolve(1)?.seq).toBe(1)
    expect(table.resolve('1')?.seq).toBe(2)
  })

  it('serverRequest/resolved 与 attach 快照、清空', () => {
    const table = new PendingRequests()
    table.add('a', request, 7)
    table.add('b', request, 8)
    expect(table.snapshot().map((p) => p.id)).toEqual(['a', 'b'])
    expect(table.drop('a')).toBe(true)
    expect(table.drop('a')).toBe(false)
    expect(table.snapshot().map((p) => p.id)).toEqual(['b'])
    table.clear()
    expect(table.size).toBe(0)
  })

  it('相同 id 重复 add 不覆盖首个请求', () => {
    const table = new PendingRequests()
    table.add('x', request, 1)
    table.add('x', { id: 'x', method: 'other' }, 2)
    expect(table.snapshot()).toEqual([{ id: 'x', seq: 1, msg: request }])
  })
})
