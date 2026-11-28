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

it('识别旧版 SSH 项目的盘符路径，并继续隔离不同目标和项目', () => {
  const receive = vi.fn()
  const close = receiveProjectMentions('ssh', '/D:/Work/Repo', receive)
  try {
    expect(addProjectMention('other', 'd:\\work\\repo', 'src/a b.ts')).toBe(false)
    expect(addProjectMention('ssh', 'd:\\work\\repo2', 'src/a b.ts')).toBe(false)
    expect(addProjectMention('ssh', 'd:\\work\\repo', 'src/a b.ts')).toBe(true)
    expect(receive.mock.calls).toEqual([['src/a b.ts']])
  } finally {
    close()
  }
})
