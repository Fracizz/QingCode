import { describe, expect, it } from 'vitest'
import { historyModelPrefs, inheritedModelPrefs, matchModelOption, reconcileThreadPrefs, sameModelConfig, turnModelNote, type ModelOptionLike } from './threadModel'

const option = (model: string, extra: Partial<ModelOptionLike> = {}): ModelOptionLike => ({
  model, isDefault: false, efforts: [{ value: 'low' }, { value: 'high' }], defaultEffort: 'low', serviceTiers: [], ...extra,
})
const codex = [
  option('gpt-big', { isDefault: true, serviceTiers: [{ id: 'priority', name: 'Fast' }] }),
  option('gpt-small'),
]
const claude = [option('default'), option('opus'), option('opus[1m]'), option('sonnet')]

describe('会话模型配置', () => {
  it('Claude 完整模型 ID 对应到别名', () => {
    expect(matchModelOption(claude, 'claude-opus-5-5')).toBe('opus')
    expect(matchModelOption(claude, 'gpt-5')).toBeNull()
  })

  it('强度为空按模型默认比较，跟随默认模型等同于默认模型', () => {
    expect(sameModelConfig(codex, { model: 'gpt-big', effort: null }, { model: 'gpt-big', effort: 'low' })).toBe(true)
    expect(sameModelConfig(codex, { model: null, effort: null }, { model: 'gpt-big', effort: null })).toBe(true)
    expect(sameModelConfig(codex, { model: 'gpt-big', effort: 'high' }, { model: 'gpt-big', effort: 'low' })).toBe(false)
    expect(sameModelConfig(claude, { model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5', effort: null }, 'claude')).toBe(true)
  })

  it('历史 → 偏好，并恢复 Codex 快速档', () => {
    const base = { model: null, effort: 'high', fast: false }
    expect(historyModelPrefs('codex', codex, base, { model: 'gpt-big', effort: null, serviceTier: 'priority' }))
      .toEqual({ model: 'gpt-big', effort: null, fast: true, seen: { model: 'gpt-big', effort: null } })
    expect(historyModelPrefs('claude', claude, base, { model: 'claude-opus-5-5', effort: null })?.effort).toBe('high')
    expect(historyModelPrefs('codex', [], base, { model: 'gpt-big', effort: null })).toBeNull()
  })

  it('另一端换了模型时采用历史，本机自己发的不算', () => {
    const own = { model: 'gpt-big', effort: 'high', fast: true, seen: { model: 'gpt-big', effort: 'high' } }
    // 历史没变（还是记录时看到的）：保持本机，哪怕本机已改选未发送。
    expect(reconcileThreadPrefs('codex', codex, { ...own, model: 'gpt-small' }, { model: 'gpt-big', effort: 'high' })).toBeNull()
    // 历史变成了别的模型：采用历史，没回报的快速档保留本机值。
    expect(reconcileThreadPrefs('codex', codex, own, { model: 'gpt-small', effort: 'low' }))
      .toEqual({ model: 'gpt-small', effort: 'low', fast: true, seen: { model: 'gpt-small', effort: 'low' } })
    // 历史变了但就是本机的选择：只更新 seen。
    const stale = { ...own, seen: { model: 'gpt-small', effort: 'low' } }
    expect(reconcileThreadPrefs('codex', codex, stale, { model: 'gpt-big', effort: 'high' }))
      .toEqual({ ...own, seen: { model: 'gpt-big', effort: 'high' } })
    // Claude 历史没有强度：采用模型时保留本机强度。
    const claudeOwn = { model: 'sonnet', effort: 'max', fast: false, seen: { model: 'claude-sonnet-5-5', effort: null } }
    expect(reconcileThreadPrefs('claude', claude, claudeOwn, { model: 'claude-opus-5-5', effort: null }))
      .toMatchObject({ model: 'opus', effort: 'max' })
  })

  it('开新会话时沿用原会话选择，首轮覆盖项优先且不带 seen', () => {
    const source = { model: 'gpt-big', effort: 'high', fast: true, seen: { model: 'gpt-big', effort: 'high' } }
    expect(inheritedModelPrefs(source)).toEqual({ model: 'gpt-big', effort: 'high', fast: true })
    expect(inheritedModelPrefs(source, { model: 'gpt-small', effort: 'low', serviceTier: null }))
      .toEqual({ model: 'gpt-small', effort: 'low', fast: false })
  })

  it('换了模型或强度才生成提示，首轮或未显式指定模型时不提示', () => {
    const label = (config: { model: string; effort: string | null }) => `${config.model} ${config.effort ?? ''}`.trim()
    const thread = { savedConfig: { model: 'gpt-big', effort: null } }
    expect(turnModelNote('codex', codex, thread, { model: 'gpt-big', effort: 'low' }, 'c1', label)).toEqual({ config: { model: 'gpt-big', effort: 'low' } })
    expect(turnModelNote('codex', codex, thread, { model: 'gpt-small', effort: 'low' }, 'c1', label)?.notice)
      .toMatchObject({ id: 'model-switch-c1', anchor: 'c1' })
    expect(turnModelNote('codex', codex, { ...thread, lastTurnConfig: { model: 'gpt-small', effort: 'low' } },
      { model: 'gpt-small', effort: 'low' }, 'c2', label)?.notice).toBeUndefined()
    expect(turnModelNote('codex', codex, undefined, { model: 'gpt-small' }, 'c3', label)?.notice).toBeUndefined()
    expect(turnModelNote('claude', claude, thread, {}, 'c4', label)).toBeNull()
  })
})
