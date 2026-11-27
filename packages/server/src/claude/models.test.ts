/** 模型/强度映射纯逻辑：静态别名、SDK 真实列表、覆盖项与差异。 */
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_EFFORTS,
  NO_OVERRIDES,
  parseOverrides,
  queryOverrides,
  settingsDiff,
  staticModelList,
  supportedModelList,
  threadModelConfig,
} from './models'
import type { Json } from './v2'

function data(list: Json | null): Json[] {
  return (list?.data ?? []) as Json[]
}

describe('静态别名列表', () => {
  it('六个官方别名，形状为 v2 ModelListResponse/Model，且不声明 serviceTier', () => {
    const list = staticModelList()
    expect(list.nextCursor).toBeNull()
    const rows = data(list)
    expect(rows.map((row) => row.model)).toEqual([
      'default',
      'sonnet',
      'opus',
      'haiku',
      'sonnet[1m]',
      'opusplan',
    ])
    expect(rows[0]).toMatchObject({
      id: 'default',
      displayName: '账号默认',
      isDefault: true,
      hidden: false,
      serviceTiers: [],
      defaultServiceTier: null,
      additionalSpeedTiers: [],
      supportsPersonality: false,
      inputModalities: ['text', 'image'],
    })
    for (const row of rows) {
      expect(String(row.description)).toContain('别名，由 Claude 自身配置解析')
      expect(row.supportedReasoningEfforts).toEqual(
        CLAUDE_EFFORTS.map((effort) => ({ reasoningEffort: effort, description: '' })),
      )
      expect(row.defaultReasoningEffort).toBe('medium')
      expect(row.serviceTiers).toEqual([])
      // vendor Model 的必填字段都要在，字段缺失会让严格客户端解析失败。
      for (const field of ['upgrade', 'upgradeInfo', 'availabilityNux', 'modelSpecialty', 'multiAgentVersion', 'availableAccessPrograms']) {
        expect(row).toHaveProperty(field)
      }
    }
    expect(rows.filter((row) => row.isDefault === true)).toHaveLength(1)
  })
})

describe('supportedModels() 结果映射', () => {
  it('value/展示文案/逐模型 effort 映射，默认项与别名 id 一致', () => {
    const list = supportedModelList([
      { displayName: '缺 value' },
      {
        value: 'default',
        displayName: 'Default',
        description: 'Opus 4.6',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max', 'bogus'],
        supportsFastMode: true,
      },
      { value: 'haiku', displayName: 'Haiku', description: 'Fast', supportsEffort: false },
      { value: 'custom', displayName: 'Custom', supportsEffort: true },
    ])
    const rows = data(list)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      model: 'default',
      displayName: 'Default',
      description: 'Opus 4.6',
      isDefault: true,
      defaultReasoningEffort: 'medium',
    })
    expect(rows[0]?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'medium', description: '' },
      { reasoningEffort: 'high', description: '' },
      { reasoningEffort: 'max', description: '' },
    ])
    // 快速模式是 Claude 自己的 flag，不是 Codex 的 serviceTier，不能声明该能力。
    expect(rows[0]?.serviceTiers).toEqual([])
    expect(rows[1]).toMatchObject({ model: 'haiku', isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: null })
    expect((rows[2]?.supportedReasoningEfforts as unknown[]) ?? []).toHaveLength(CLAUDE_EFFORTS.length)
  })

  it('没有 default 时首项为默认；空表/坏数据返回 null 让调用方回退别名', () => {
    const rows = data(supportedModelList([null, { value: 'sonnet', displayName: 'Sonnet' }, { value: 'opus' }]))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.isDefault).toBe(true)
    expect(rows[1]?.isDefault).toBe(false)
    expect(supportedModelList([])).toBeNull()
    expect(supportedModelList(null)).toBeNull()
    expect(supportedModelList([{ displayName: '无 value' }])).toBeNull()
  })
})

describe('turn/start 覆盖项', () => {
  it('default 别名 → 不覆盖；非法 effort 与 serviceTier 一律忽略', () => {
    expect(parseOverrides({ model: 'default', effort: 'high', serviceTier: 'fast' }, NO_OVERRIDES)).toEqual({
      model: null,
      effort: 'high',
    })
    expect(parseOverrides({ model: ' opus ', effort: 'bogus', serviceTier: null }, NO_OVERRIDES)).toEqual({
      model: 'opus',
      effort: null,
    })
    expect(parseOverrides({ serviceTier: 'fast' }, { model: 'sonnet', effort: 'low' })).toEqual({
      model: 'sonnet',
      effort: 'low',
    })
    expect(parseOverrides({ model: null }, { model: 'sonnet', effort: 'low' })).toEqual({
      model: null,
      effort: 'low',
    })
  })

  it('只把非空覆盖项放进新 query 的 options', () => {
    expect(queryOverrides(NO_OVERRIDES)).toEqual({})
    expect(queryOverrides({ model: 'opus', effort: 'xhigh' })).toEqual({ model: 'opus', effort: 'xhigh' })
  })

  it('settingsDiff 只返回变化字段，null 表示恢复 Claude 自身默认', () => {
    expect(settingsDiff({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' })).toBeNull()
    expect(settingsDiff({ model: 'opus', effort: 'high' }, { model: null, effort: 'max' })).toEqual({
      model: null,
      effort: 'max',
    })
    expect(settingsDiff({ model: null, effort: null }, { model: 'sonnet', effort: null })).toEqual({ model: 'sonnet' })
  })

  it('Thread 形状用 v2 的 model / reasoningEffort 字段名', () => {
    expect(threadModelConfig({ model: 'opus', effort: 'max' })).toEqual({ model: 'opus', reasoningEffort: 'max' })
    expect(threadModelConfig(NO_OVERRIDES)).toEqual({ model: null, reasoningEffort: null })
  })
})
