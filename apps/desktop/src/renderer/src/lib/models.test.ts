import { describe, expect, it } from 'vitest'
import {
  contextUsage,
  effortLabel,
  fastTier,
  filterModels,
  formatTokens,
  parsePrefs,
  resolveSelection,
  toModelOptions,
  triggerLabel,
  turnOverrides,
  type ModelOption,
} from './models'

const raw = [
  {
    id: 'sol',
    model: 'gpt-sol',
    displayName: '6.2 Sol',
    description: 'Fast, go-to model',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'medium', description: '' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
  },
  {
    id: 'astra',
    model: 'gpt-astra',
    displayName: '6.2 Astra',
    description: 'Most capable',
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'high', description: '' },
      { reasoningEffort: 'xhigh', description: '' },
    ],
    defaultReasoningEffort: 'high',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
  },
  { id: 'old', model: 'gpt-old', displayName: 'Old', description: 'legacy', hidden: true },
  { broken: true },
]

const models: ModelOption[] = toModelOptions(raw)

describe('toModelOptions', () => {
  it('丢弃坏条目并映射字段', () => {
    expect(models.map((m) => m.model)).toEqual(['gpt-sol', 'gpt-astra', 'gpt-old'])
    expect(models[1]!.efforts.map((e) => e.value)).toEqual(['low', 'high', 'xhigh'])
    expect(toModelOptions(null)).toEqual([])
  })
})

describe('filterModels', () => {
  it('空查询隐藏 hidden 模型，搜索时可找到', () => {
    expect(filterModels(models, '').map((m) => m.id)).toEqual(['sol', 'astra'])
    expect(filterModels(models, 'legacy').map((m) => m.id)).toEqual(['old'])
    expect(filterModels(models, 'ASTRA').map((m) => m.id)).toEqual(['astra'])
  })
})

describe('effortLabel / fastTier', () => {
  it('常见强度用短标签', () => {
    expect(effortLabel('medium')).toBe('Med')
    expect(effortLabel('xhigh')).toBe('XHigh')
    expect(effortLabel('turbo')).toBe('Turbo')
    expect(effortLabel(null)).toBe('')
  })

  it('识别加速档位', () => {
    expect(fastTier(models[1])).toBe('priority')
    expect(fastTier(models[0])).toBeNull()
  })
})

describe('resolveSelection', () => {
  it('无偏好时用默认模型与默认强度', () => {
    const s = resolveSelection(models, { model: null, effort: null, fast: false })
    expect(s.model?.id).toBe('sol')
    expect(s.effort).toBe('medium')
    expect(triggerLabel(s)).toBe('6.2 Sol Med')
  })

  it('强度不被支持时回落到模型默认', () => {
    const s = resolveSelection(models, { model: 'gpt-sol', effort: 'xhigh', fast: true })
    expect(s.effort).toBe('medium')
    expect(s.fast).toBe(false)
  })

  it('偏好模型下线时回落默认', () => {
    expect(resolveSelection(models, { model: 'gone', effort: null, fast: false }).model?.id).toBe('sol')
  })

  it('生成 turn/start 覆盖项', () => {
    const s = resolveSelection(models, { model: 'gpt-astra', effort: 'xhigh', fast: true })
    expect(turnOverrides(s)).toEqual({ model: 'gpt-astra', effort: 'xhigh', serviceTier: 'priority' })
    const slow = resolveSelection(models, { model: 'gpt-astra', effort: null, fast: false })
    expect(turnOverrides(slow)).toEqual({ model: 'gpt-astra', effort: 'high', serviceTier: null })
    expect(turnOverrides(resolveSelection([], { model: null, effort: null, fast: false }))).toEqual({})
  })
})

describe('parsePrefs', () => {
  it('损坏数据回落为空', () => {
    expect(parsePrefs('{bad')).toEqual({})
    expect(parsePrefs(null)).toEqual({})
    expect(parsePrefs('{"codex":{"model":"m","effort":"high","fast":true},"x":1}')).toEqual({
      codex: { model: 'm', effort: 'high', fast: true },
    })
  })
})

describe('contextUsage', () => {
  it('按最近一次 totalTokens 计算占比', () => {
    expect(contextUsage({ last: { totalTokens: 50_000 }, modelContextWindow: 200_000 })).toEqual({
      used: 50_000,
      window: 200_000,
      percent: 25,
    })
    expect(contextUsage({ last: { totalTokens: 1 }, modelContextWindow: null })).toBeNull()
    expect(contextUsage(undefined)).toBeNull()
  })

  it('格式化 token 数', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1500)).toBe('1.5K')
    expect(formatTokens(258_000)).toBe('258K')
    expect(formatTokens(1_000_000)).toBe('1M')
  })
})
