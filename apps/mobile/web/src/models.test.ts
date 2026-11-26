import { describe, expect, it } from 'vitest'
import {
  EMPTY_PREFS,
  effortLabel,
  fastTier,
  overridesFor,
  parsePrefs,
  pickModel,
  resolveSelection,
  toModelOptions,
  triggerLabel,
  visibleModels,
} from './models'

const RAW = {
  data: [
    {
      id: 'm1',
      model: 'gpt-big',
      displayName: 'Big',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'low',
      serviceTiers: [{ id: 'priority', name: 'Fast' }],
    },
    { id: 'm2', model: 'gpt-small', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }] },
    { id: 'm3', model: 'gpt-hidden', hidden: true },
    { displayName: '缺 model 字段' },
    'bad',
  ],
}

describe('model/list 归一化与选择', () => {
  const models = toModelOptions(RAW)

  it('丢弃坏条目，补全显示名与档位', () => {
    expect(models.map((item) => item.model)).toEqual(['gpt-big', 'gpt-small', 'gpt-hidden'])
    expect(models[1]?.displayName).toBe('gpt-small')
    expect(fastTier(models[0])).toBe('priority')
    expect(fastTier(models[1])).toBeNull()
    expect(toModelOptions(null)).toEqual([])
    expect(visibleModels(models).map((item) => item.model)).toEqual(['gpt-big', 'gpt-small'])
    expect(visibleModels(models, 'gpt-hidden').map((item) => item.model)).toContain('gpt-hidden')
  })

  it('偏好失效时回落默认模型 / 默认强度', () => {
    expect(resolveSelection(models, EMPTY_PREFS)).toMatchObject({ effort: 'low', fast: false })
    expect(resolveSelection(models, EMPTY_PREFS).model?.model).toBe('gpt-big')
    expect(resolveSelection(models, { model: 'gone', effort: 'high', fast: true }).model?.model).toBe('gpt-big')
    expect(resolveSelection(models, { model: 'gpt-small', effort: 'high', fast: true })).toMatchObject({
      effort: 'minimal',
      fast: false,
    })
    expect(triggerLabel(resolveSelection(models, EMPTY_PREFS))).toBe('Big · 低')
    expect(effortLabel('xhigh')).toBe('超高')
    expect(effortLabel('weird')).toBe('Weird')
  })

  it('换模型时清掉新模型不支持的强度', () => {
    expect(pickModel(models, { model: 'gpt-big', effort: 'high', fast: false }, 'gpt-small')).toEqual({
      model: 'gpt-small',
      effort: null,
      fast: false,
    })
    expect(pickModel(models, { model: null, effort: 'low', fast: true }, 'gpt-big')).toEqual({
      model: 'gpt-big',
      effort: 'low',
      fast: true,
    })
  })
})

describe('turn/start 覆盖项', () => {
  const models = toModelOptions(RAW)

  it('Codex 发送生效选择与快速档', () => {
    expect(overridesFor('codex', models, EMPTY_PREFS)).toEqual({ model: 'gpt-big', effort: 'low', serviceTier: null })
    expect(overridesFor('codex', models, { model: 'gpt-big', effort: 'high', fast: true })).toEqual({
      model: 'gpt-big',
      effort: 'high',
      serviceTier: 'priority',
    })
    expect(overridesFor('codex', [], { model: 'x', effort: 'high', fast: true })).toEqual({})
  })

  it('Claude / pi 只发显式选过的项，且不发 serviceTier', () => {
    expect(overridesFor('claude', models, EMPTY_PREFS)).toEqual({})
    expect(overridesFor('claude', models, { model: 'gpt-small', effort: null, fast: true })).toEqual({ model: 'gpt-small' })
    expect(overridesFor('pi', models, { model: null, effort: 'high', fast: false })).toEqual({ effort: 'high' })
  })

  it('偏好表解析容错', () => {
    expect(parsePrefs('{"codex:local":{"model":"m","effort":"","fast":true},"x":1}')).toEqual({
      'codex:local': { model: 'm', effort: null, fast: true },
    })
    expect(parsePrefs('not json')).toEqual({})
    expect(parsePrefs(null)).toEqual({})
  })
})
