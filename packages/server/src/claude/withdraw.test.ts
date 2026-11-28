import { describe, expect, it, vi } from 'vitest'
import { withdrawMessages } from './withdraw'

describe('撤回排队消息', () => {
  it('只返回确认撤回的 UUID，保持方法的 this', async () => {
    const onError = vi.fn()
    const query = {
      answers: new Map([['yes', true], ['no', false]]),
      async cancelAsyncMessage(uuid: string): Promise<boolean> {
        if (uuid === 'broken') throw new Error('失败')
        return this.answers.get(uuid) ?? false
      },
    }
    expect(await withdrawMessages(query, ['yes', 'no', 'broken'], onError)).toEqual(['yes'])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('SDK 没有该方法或迟迟不回时按未撤回处理', async () => {
    expect(await withdrawMessages({}, ['a'], vi.fn())).toEqual([])
    const hanging = { cancelAsyncMessage: () => new Promise<boolean>(() => undefined) }
    expect(await withdrawMessages(hanging, ['a'], vi.fn(), 10)).toEqual([])
  })
})
