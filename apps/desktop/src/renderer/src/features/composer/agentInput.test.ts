import { describe, expect, it } from 'vitest'
import type { UserInput } from '@qn/codex-client'
import { adaptTurnInput } from './agentInput'

const text = (value: string): UserInput => ({ type: 'text', text: value, text_elements: [] })

describe('adaptTurnInput', () => {
  const input: UserInput[] = [
    { type: 'skill', name: 'review', path: '/s/review' },
    text('看下 @src/a.ts'),
    { type: 'image', url: 'data:image/png;base64,QUJD' },
    { type: 'mention', name: 'log.txt', path: '/home/u/.qingcode-next/uploads/log.txt' },
  ]

  it('Claude / pi 原样返回（桥自己处理 mention）', () => {
    expect(adaptTurnInput('claude', input)).toBe(input)
    expect(adaptTurnInput('pi', input)).toBe(input)
  })

  it('Codex：文件 mention 并入正文末尾的附件说明，其余顺序不变', () => {
    expect(adaptTurnInput('codex', input)).toEqual([
      { type: 'skill', name: 'review', path: '/s/review' },
      text('看下 @src/a.ts\n\n附件文件（请按需读取）：\n- log.txt: /home/u/.qingcode-next/uploads/log.txt'),
      { type: 'image', url: 'data:image/png;base64,QUJD' },
    ])
  })

  it('Codex：app / plugin mention 保持原生形式', () => {
    const app: UserInput[] = [text('$demo 总结'), { type: 'mention', name: 'Demo', path: 'app://demo' }]
    expect(adaptTurnInput('codex', app)).toBe(app)
  })

  it('Codex：没有正文时说明单独成文本项，放在技能之后', () => {
    const result = adaptTurnInput('codex', [
      { type: 'skill', name: 'review', path: '/s' },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'mention', name: 'a', path: 'C:\\a.txt' },
    ])
    expect(result.map((item) => item.type)).toEqual(['skill', 'text', 'image'])
    expect(result[1]).toEqual(text('附件文件（请按需读取）：\n- a: C:\\a.txt'))
  })

  it('Codex：只有 mention 时得到单个文本项', () => {
    expect(adaptTurnInput('codex', [{ type: 'mention', name: '', path: '/p' }])).toEqual([
      text('附件文件（请按需读取）：\n- /p: /p'),
    ])
  })
})
