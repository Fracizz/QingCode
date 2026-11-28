import { describe, expect, it } from 'vitest'
import { textWidth, twoColumnOptions } from './userInputLayout'

describe('userInputLayout', () => {
  it('全角字符按 2 计宽', () => {
    expect(textWidth('写作 / 文案')).toBe(4 + 3 + 4)
    expect(textWidth('Excel')).toBe(5)
  })

  it('短选项两列', () => {
    expect(twoColumnOptions([
      { label: '简洁直接', description: '先给结论，少铺垫' },
      { label: '详细深入', description: '展开讲透，含示例依据' },
    ])).toBe(true)
  })

  it('有一项偏长就单列', () => {
    expect(twoColumnOptions([
      { label: '是' },
      { label: '否，改用另一个方案并重新规划全部步骤' },
    ])).toBe(false)
    expect(twoColumnOptions([
      { label: '文档文件', description: '生成 Word、PDF 等可以下载的文件格式' },
      { label: '聊天回复' },
    ])).toBe(false)
  })

  it('单个选项不分列', () => {
    expect(twoColumnOptions([{ label: '好' }])).toBe(false)
  })
})
