import { describe, expect, it } from 'vitest'
import { parsePiModelKey, piModelList } from './models'

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

describe('parsePiModelKey', () => {
  it('首个斜杠前为 provider，模型 id 可含斜杠', () => {
    expect(parsePiModelKey('openrouter/anthropic/claude')).toEqual({ provider: 'openrouter', modelId: 'anthropic/claude' })
    expect(parsePiModelKey('nope')).toBeNull()
  })
})
