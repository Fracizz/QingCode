import { describe, expect, it } from 'vitest'
import type { TurnContent } from '../claude/userInput'
import { promptFromContent, resolvePiPrompt, type PiPrompt } from './turnInput'

function content(overrides: Partial<TurnContent> = {}): TurnContent {
  return {
    blocks: [{ type: 'text', text: '列出当前目录' }],
    echo: [{ type: 'text', text: '列出当前目录', text_elements: [] }],
    text: '列出当前目录',
    ...overrides,
  }
}

describe('pi prompt 输入映射', () => {
  it('文本直接作为 message，没有图片时不带 images 字段', () => {
    expect(promptFromContent(content())).toEqual({ message: '列出当前目录' })
  })

  it('base64 图片转成 pi 的 ImageContent；URL 图片忽略（pi 只接受 base64）', () => {
    const result = promptFromContent(
      content({
        blocks: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'text', text: '看图' },
        ],
        text: '看图',
      }),
    )
    expect(result.images).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])
    expect(result.message).toBe('看图')
  })

  it('v2 UserInput → pi prompt，并保留回显内容', async () => {
    const resolved = await resolvePiPrompt([
      { type: 'text', text: '你好', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
    ])
    expect(resolved.prompt.message).toBe('你好')
    expect(resolved.prompt.images?.[0]?.data).toBe('AAAA')
    expect(resolved.echo).toHaveLength(2)
  })

  it('本地图片按注入的 IO 读取，不触碰凭据文件', async () => {
    const resolved = await resolvePiPrompt(
      [{ type: 'localImage', path: '/work/a.png' }],
      {
        size: async () => 4,
        read: async () => Buffer.from('AAAA'),
      },
    )
    expect(resolved.prompt.images).toEqual([
      { type: 'image', data: Buffer.from('AAAA').toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('空输入报错，不自动构造 prompt', async () => {
    await expect(resolvePiPrompt([])).rejects.toThrow(/需要文本/)
  })
})

describe('PiPrompt 形状', () => {
  it('images 是可选的', () => {
    const prompt: PiPrompt = { message: 'x' }
    expect(prompt.images).toBeUndefined()
  })
})
