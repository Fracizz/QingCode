import { expect, it } from 'vitest'
import type { UserInput } from '@qn/codex-client'
import { replacePendingText } from './pendingQueue'

const skill = { type: 'skill', name: 'review', path: 'SKILL.md' } as const
const image = { type: 'image', url: 'data:image/png;base64,AA==' } as const
const text = (value: string): UserInput => ({ type: 'text', text: value, text_elements: [] })

it('只替换原正文，技能和附件顺序不变', () => {
  expect(replacePendingText([skill, text('旧'), image], '旧', '新')).toEqual([skill, text('新'), image])
})

it('清空正文时移除文本段，全部为空返回 null', () => {
  expect(replacePendingText([text('旧'), image], '旧', '  ')).toEqual([image])
  expect(replacePendingText([text('旧')], '旧', '')).toBeNull()
})

it('原来只有附件时把正文插在技能之后', () => {
  expect(replacePendingText([skill, image], '', '补充')).toEqual([skill, text('补充'), image])
})
