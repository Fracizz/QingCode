import { describe, expect, it } from 'vitest'
import { IdMapper } from './idMapper'

describe('IdMapper', () => {
  it('分配的 daemon id 互不冲突，响应按原 id 还原', () => {
    const mapper = new IdMapper()
    const a = mapper.allocate(1, 7)
    const b = mapper.allocate(2, 7)
    expect(a).not.toBe(b)
    expect(mapper.size).toBe(2)

    expect(mapper.take(a)).toEqual({ clientId: 1, originalId: 7, daemonId: a })
    expect(mapper.take(b)).toEqual({ clientId: 2, originalId: 7, daemonId: b })
    expect(mapper.size).toBe(0)
  })

  it('字符串 id 与数字 id 都能还原', () => {
    const mapper = new IdMapper()
    const id = mapper.allocate(3, 'abc')
    expect(mapper.take(id)?.originalId).toBe('abc')
  })

  it('未知或非字符串 daemon id 被忽略', () => {
    const mapper = new IdMapper()
    mapper.allocate(1, 1)
    expect(mapper.take(1)).toBeUndefined()
    expect(mapper.take('qn-c999')).toBeUndefined()
  })

  it('客户端断开只清理自己的请求', () => {
    const mapper = new IdMapper()
    const a = mapper.allocate(1, 10)
    const b = mapper.allocate(2, 20)
    mapper.allocate(1, 11)
    expect(mapper.dropClient(1).map((e) => e.originalId)).toEqual([10, 11])
    expect(mapper.size).toBe(1)
    expect(mapper.take(b)?.clientId).toBe(2)
  })

  it('clear 返回全部未完成请求', () => {
    const mapper = new IdMapper()
    mapper.allocate(1, 1)
    mapper.allocate(2, 2)
    expect(mapper.clear()).toHaveLength(2)
    expect(mapper.size).toBe(0)
  })
})
