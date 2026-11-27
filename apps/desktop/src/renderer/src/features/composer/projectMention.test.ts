import { expect, it, vi } from 'vitest'
import { addProjectMention, receiveProjectMentions } from './projectMention'

it('只向同一目标、同一项目的活动输入框添加路径', () => {
  const receive = vi.fn()
  const close = receiveProjectMentions('ssh', '/work', receive)
  try {
    expect(addProjectMention('local', '/work', 'a.ts')).toBe(false)
    expect(addProjectMention('ssh', '/other', 'a.ts')).toBe(false)
    expect(addProjectMention('ssh', '/work', '')).toBe(false)
    expect(addProjectMention('ssh', '/work', 'a.ts')).toBe(true)
    expect(receive.mock.calls).toEqual([['a.ts']])
  } finally {
    close()
  }
  expect(addProjectMention('ssh', '/work', 'a.ts')).toBe(false)
})
