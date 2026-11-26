import { describe, expect, it } from 'vitest'
import type { UserInput } from './codex-types'
import { requestSubagents, supportsSubagentRequests } from './subagents'

describe('随本条消息请求子代理', () => {
  it('只为 Codex 和 Claude 提供入口', () => {
    expect(supportsSubagentRequests('codex')).toBe(true)
    expect(supportsSubagentRequests('claude')).toBe(true)
    expect(supportsSubagentRequests('pi')).toBe(false)
  })

  it('追加请求时保留正文偏移、技能、图片与原始草稿', () => {
    const text: UserInput = { type: 'text', text: '@a', text_elements: [{ byteRange: { start: 0, end: 2 }, placeholder: '@a' }] }
    const skill: UserInput = { type: 'skill', name: 'demo', path: '/work/skills/demo' }
    const image: UserInput = { type: 'image', url: 'data:image/png;base64,AA==' }
    const input = [skill, text, image]
    const next = requestSubagents(input)
    expect(next).toEqual([skill, { ...text, text: expect.stringMatching(/^@a\n\n请.*子代理/) }, image])
    expect(input[1]).toEqual(text)
    expect(requestSubagents([image])).toEqual([image, {
      type: 'text', text: expect.stringContaining('子代理'), text_elements: [],
    }])
  })
})
