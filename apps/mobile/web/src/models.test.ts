import { describe, expect, it } from 'vitest'
import {
  EMPTY_PREFS,
  effortLabel,
  fastTier,
  overridesFor,
  parsePrefs,
  pickModel,
  prefsFor,
  putThreadPrefs,
  resolveSelection,
  threadPrefsKey,
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
      description: 'For complex tasks',
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

  it('按名称、标识和描述搜索模型，保留当前的隐藏模型规则', () => {
    expect(visibleModels(models, null, '  BiG  ').map((item) => item.model)).toEqual(['gpt-big'])
    expect(visibleModels(models, null, 'gpt-small').map((item) => item.model)).toEqual(['gpt-small'])
    expect(visibleModels(models, null, 'complex').map((item) => item.model)).toEqual(['gpt-big'])
    expect(visibleModels(models, null, 'hidden')).toEqual([])
    expect(visibleModels(models, 'gpt-hidden', 'hidden').map((item) => item.model)).toEqual(['gpt-hidden'])
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

describe('按会话记忆模型偏好', () => {
  const models = toModelOptions(RAW)
  const sid = 'codex:local'

  it('会话记录优先，其次会话历史配置，最后 agent 默认', () => {
    const table = {
      [sid]: { model: 'gpt-big', effort: 'high', fast: true },
      [threadPrefsKey(sid, 't1')]: { model: 'gpt-big', effort: 'low', fast: false },
    }
    expect(prefsFor(table, 'codex', sid, null, models)).toEqual(table[sid])
    expect(prefsFor(table, 'codex', sid, 't1', models)).toEqual(table[threadPrefsKey(sid, 't1')])
    expect(prefsFor(table, 'codex', sid, 't2', models, { model: 'gpt-big', effort: null }))
      .toMatchObject({ model: 'gpt-big', effort: null, fast: true })
    // 历史模型不在列表里或列表未加载时回落 agent 默认。
    expect(prefsFor(table, 'codex', sid, 't2', models, { model: 'gone', effort: 'low' })).toEqual(table[sid])
    expect(prefsFor(table, 'codex', sid, 't2', [], { model: 'gpt-big', effort: 'low' })).toEqual(table[sid])
    expect(prefsFor({}, 'codex', sid, 't3', models)).toEqual(EMPTY_PREFS)
  })

  it('Claude 历史的完整模型 ID 对应到别名，缺强度时沿用默认', () => {
    const claude = toModelOptions([
      { model: 'default', displayName: '默认' },
      { model: 'opus', displayName: 'Opus' },
      { model: 'opus[1m]', displayName: 'Opus 1M' },
    ])
    const table = { 'claude:local': { model: null, effort: 'max', fast: false } }
    expect(prefsFor(table, 'claude', 'claude:local', 't', claude, { model: 'claude-opus-5-5', effort: null }))
      .toMatchObject({ model: 'opus', effort: 'max', fast: false })
  })

  it('Codex 历史回报的服务档位恢复快速开关，没回报时沿用默认', () => {
    const table = { [sid]: { model: null, effort: null, fast: true } }
    expect(prefsFor(table, 'codex', sid, 't', models, { model: 'gpt-big', effort: null, serviceTier: null }).fast).toBe(false)
    expect(prefsFor({}, 'codex', sid, 't', models, { model: 'gpt-big', effort: null, serviceTier: 'priority' }).fast).toBe(true)
    expect(prefsFor(table, 'codex', sid, 't', models, { model: 'gpt-big', effort: null }).fast).toBe(true)
  })

  it('电脑端用别的模型发过消息后，手机改用历史里的配置', () => {
    const key = threadPrefsKey(sid, 't')
    const table = { [key]: { model: 'gpt-big', effort: 'high', fast: false, seen: { model: 'gpt-big', effort: 'high' } } }
    expect(prefsFor(table, 'codex', sid, 't', models, { model: 'gpt-big', effort: 'high' })).toBe(table[key])
    expect(prefsFor(table, 'codex', sid, 't', models, { model: 'gpt-small', effort: 'minimal' }))
      .toMatchObject({ model: 'gpt-small', effort: 'minimal' })
  })

  it('会话记录有上限，agent 默认不被淘汰', () => {
    let table: Record<string, typeof EMPTY_PREFS> = { [sid]: EMPTY_PREFS }
    for (let i = 0; i < 510; i++) table = putThreadPrefs(table, threadPrefsKey(sid, `t${i}`), EMPTY_PREFS)
    expect(table[sid]).toEqual(EMPTY_PREFS)
    expect(table[threadPrefsKey(sid, 't0')]).toBeUndefined()
    expect(table[threadPrefsKey(sid, 't509')]).toEqual(EMPTY_PREFS)
    expect(Object.keys(table)).toHaveLength(501)
  })
})
