import { describe, expect, it } from 'vitest'
import { modalitiesOf, parsePiModelKey, piModelList } from './models'

describe('piModelList', () => {
  it('当前模型为默认，并使用它的实际推理档位', () => {
    const models = [
      { id: 'hy4', name: 'HY4', provider: 'opencode-go-zen', reasoning: true },
      { id: 'small', name: 'Small', provider: 'local', reasoning: false },
    ]
    const result = piModelList(models, {
      model: models[0],
      thinkingLevel: 'high',
      levels: ['off', 'low', 'high', 'xhigh'],
    })
    const data = result.data as Record<string, unknown>[]
    expect(data[0]).toMatchObject({ model: 'opencode-go-zen/hy4', displayName: 'HY4', isDefault: true, defaultReasoningEffort: 'high' })
    expect((data[0]!.supportedReasoningEfforts as unknown[]).length).toBe(4)
    expect(data[1]).toMatchObject({ model: 'local/small', isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: null })
  })
})

describe('inputModalities', () => {
  it('pi 模型的 input 映射为 inputModalities；未声明时不输出', () => {
    const result = piModelList(
      [
        { id: 'vision', provider: 'p', input: ['text', 'image'] },
        { id: 'textonly', provider: 'p', input: ['text'] },
        { id: 'unknown', provider: 'p' },
      ],
      {},
    )
    const data = result.data as Record<string, unknown>[]
    expect(data[0]!.inputModalities).toEqual(['text', 'image'])
    expect(data[1]!.inputModalities).toEqual(['text'])
    expect('inputModalities' in data[2]!).toBe(false)
  })

  it('过滤未知模态；空数组视为未声明', () => {
    expect(modalitiesOf(['text', 'audio', 'image'])).toEqual({ inputModalities: ['text', 'image'] })
    expect(modalitiesOf([])).toEqual({})
    expect(modalitiesOf('text')).toEqual({})
  })
})

describe('parsePiModelKey', () => {
  it('首个斜杠前为 provider，模型 id 可含斜杠', () => {
    expect(parsePiModelKey('openrouter/anthropic/claude')).toEqual({ provider: 'openrouter', modelId: 'anthropic/claude' })
    expect(parsePiModelKey('nope')).toBeNull()
  })
})
