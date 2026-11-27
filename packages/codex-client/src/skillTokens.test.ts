import { describe, expect, it } from 'vitest'
import { hasSkillToken, insertSkillToken, takeSkillTokens } from './skillTokens'

describe('技能标记', () => {
  it('插入时左右各留一个空格', () => {
    expect(insertSkillToken('/re', 0, 3, 'review')).toEqual({ text: '/review ', caret: 8 })
    expect(insertSkillToken('请帮我/re', 3, 6, 'review')).toEqual({ text: '请帮我 /review ', caret: 12 })
    expect(insertSkillToken('看看 /re 这段代码', 3, 6, 'review')).toEqual({ text: '看看 /review 这段代码', caret: 11 })
    expect(insertSkillToken('第一行\n/', 4, 5, 'a:b')).toEqual({ text: '第一行\n/a:b ', caret: 9 })
  })

  it('发送时拆出仍在正文里的技能并移除标记', () => {
    const picked = [{ name: 'review', path: '/r' }, { name: 'plan', path: '/p' }, { name: 'gone', path: '/g' }]
    expect(takeSkillTokens('/review 看看 /plan 这段 /review', picked)).toEqual({
      text: '看看 这段', skills: [picked[0], picked[1]],
    })
    expect(takeSkillTokens('/review ', picked)).toEqual({ text: '', skills: [picked[0]] })
    expect(takeSkillTokens('第一行\n/plan 第二行', picked)).toEqual({ text: '第一行\n第二行', skills: [picked[1]] })
  })

  it('不是完整标记时保持原文', () => {
    const picked = [{ name: 'review' }]
    expect(takeSkillTokens('打开 src/review/a.ts 和 /reviewer', picked)).toEqual({ text: '打开 src/review/a.ts 和 /reviewer', skills: [] })
    expect(hasSkillToken('a /review', 'review')).toBe(true)
    expect(hasSkillToken('a/review', 'review')).toBe(false)
  })
})
