import { beforeEach, describe, expect, it } from 'vitest'
import { sessionKey } from '../lib/agents'
import { EMPTY_PREFS, type ModelOption } from '../lib/models'
import { matchModelOption, overridesFor, prefsFor, threadPrefsKey, useModels } from './models'

const option = (model: string, efforts: string[], isDefault = false): ModelOption => ({
  id: model,
  model,
  displayName: model,
  description: '',
  hidden: false,
  isDefault,
  efforts: efforts.map((value) => ({ value, description: '' })),
  defaultEffort: efforts[0] ?? null,
  serviceTiers: [],
})

describe('按会话记模型与推理强度', () => {
  beforeEach(() => {
    useModels.setState({
      lists: { [sessionKey('local', 'codex')]: { models: [option('a', ['low', 'high'], true), option('b', ['medium', 'high'])], loading: false, error: null } },
      prefs: {},
      threadPrefs: {},
    })
  })

  it('会话内修改只影响该会话，草稿修改作为新会话默认', () => {
    const { setPrefs } = useModels.getState()
    setPrefs('codex', { model: 'b', effort: 'high' }, { targetId: 'local', threadId: 't1' })
    setPrefs('codex', { effort: 'low' }, { targetId: 'local', threadId: null })

    const state = useModels.getState()
    expect(prefsFor(state, 'local', 'codex', 't1')).toEqual({ model: 'b', effort: 'high', fast: false })
    expect(prefsFor(state, 'local', 'codex', 't2')).toEqual({ ...EMPTY_PREFS, effort: 'low' })
    expect(prefsFor(state, 'local', 'codex', null)).toEqual({ ...EMPTY_PREFS, effort: 'low' })
    expect(overridesFor('local', 'codex', 't1')).toMatchObject({ model: 'b', effort: 'high' })
    expect(overridesFor('local', 'codex', 't2')).toMatchObject({ model: 'a', effort: 'low' })
  })

  it('发送时固定到会话后，再改默认不影响已有会话', () => {
    const { setPrefs, rememberThreadPrefs } = useModels.getState()
    setPrefs('codex', { model: 'b', effort: 'medium' })
    rememberThreadPrefs('local', 'codex', 't1', prefsFor(useModels.getState(), 'local', 'codex', 't1'))
    setPrefs('codex', { model: 'a', effort: 'high' })

    expect(overridesFor('local', 'codex', 't1')).toMatchObject({ model: 'b', effort: 'medium' })
    expect(useModels.getState().threadPrefs[threadPrefsKey('local', 'codex', 't1')]).toEqual({ model: 'b', effort: 'medium', fast: false })
  })

  it('不同目标或 Agent 下同 id 的会话互不影响', () => {
    useModels.getState().setPrefs('codex', { model: 'b' }, { targetId: 'local', threadId: 't1' })
    expect(prefsFor(useModels.getState(), 'remote', 'codex', 't1')).toBe(EMPTY_PREFS)
    expect(prefsFor(useModels.getState(), 'local', 'claude', 't1')).toBe(EMPTY_PREFS)
  })

  it('历史会话没有本机记录时沿用会话历史里的配置，已有本机选择不覆盖', () => {
    const { seedFromHistory, setPrefs } = useModels.getState()
    setPrefs('codex', { model: 'a', effort: 'low', fast: true })
    seedFromHistory('local', 'codex', 'old', { model: 'b', effort: 'high' })
    expect(prefsFor(useModels.getState(), 'local', 'codex', 'old')).toEqual({ model: 'b', effort: 'high', fast: true })

    setPrefs('codex', { effort: 'medium' }, { targetId: 'local', threadId: 'old' })
    seedFromHistory('local', 'codex', 'old', { model: 'b', effort: 'high' })
    expect(prefsFor(useModels.getState(), 'local', 'codex', 'old').effort).toBe('medium')
  })

  it('Claude 历史的完整模型 ID 对应到别名，强度缺失时沿用默认；对不上或列表未就绪时不落记录', () => {
    const { seedFromHistory, setPrefs } = useModels.getState()
    setPrefs('claude', { effort: 'xhigh' })
    seedFromHistory('local', 'claude', 'early', { model: 'claude-opus-5-5', effort: null })
    expect(useModels.getState().threadPrefs).toEqual({})

    useModels.setState((state) => ({ lists: { ...state.lists, [sessionKey('local', 'claude')]: {
      models: [option('default', ['high'], true), option('opus', ['high', 'xhigh']), option('sonnet', ['high']), option('sonnet[1m]', ['high'])],
      loading: false, error: null,
    } } }))
    seedFromHistory('local', 'claude', 't1', { model: 'claude-opus-5-5', effort: null })
    expect(prefsFor(useModels.getState(), 'local', 'claude', 't1')).toEqual({ model: 'opus', effort: 'xhigh', fast: false })
    seedFromHistory('local', 'claude', 't2', { model: 'claude-mystery-1', effort: null })
    expect(useModels.getState().threadPrefs[threadPrefsKey('local', 'claude', 't2')]).toBeUndefined()
  })

  it('pi 历史按 provider/id 精确对应，并带回思考档位', () => {
    useModels.setState((state) => ({ lists: { ...state.lists, [sessionKey('local', 'pi')]: {
      models: [option('openai/gpt-5', ['low', 'high'], true), option('zen/hy4', ['low', 'high'])], loading: false, error: null,
    } } }))
    useModels.getState().seedFromHistory('local', 'pi', 'p1', { model: 'zen/hy4', effort: 'high' })
    expect(overridesFor('local', 'pi', 'p1')).toEqual({ model: 'zen/hy4', effort: 'high' })
  })
})

describe('matchModelOption', () => {
  const models = [option('default', [], true), option('opus', []), option('sonnet', []), option('sonnet[1m]', []), option('opusplan', [])]
  it('精确匹配优先，否则取被完整 ID 包含的最长无后缀别名', () => {
    expect(matchModelOption(models, 'sonnet[1m]')).toBe('sonnet[1m]')
    expect(matchModelOption(models, 'claude-sonnet-5-5')).toBe('sonnet')
    expect(matchModelOption(models, 'claude-opus-5-5[1m]')).toBe('opus')
    expect(matchModelOption(models, 'gpt-5')).toBeNull()
  })
})
