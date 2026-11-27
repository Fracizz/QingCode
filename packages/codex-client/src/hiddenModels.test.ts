import { describe, expect, it } from 'vitest'
import {
  mergeHiddenModels,
  sanitizeHiddenModels,
  sanitizeHiddenModelsPatch,
  toggleHiddenModel,
  withoutHiddenModels,
} from './hiddenModels'

describe('hiddenModels', () => {
  it('校验名单：丢弃非字符串、空串、重复项和未知 Agent', () => {
    expect(sanitizeHiddenModels({ claude: ['default', ' default ', '', 3, 'haiku'], gpt: ['x'] })).toEqual({ claude: ['default', 'haiku'] })
    expect(sanitizeHiddenModels({ claude: [] })).toBeUndefined()
    expect(sanitizeHiddenModels(null)).toBeUndefined()
    expect(sanitizeHiddenModels(JSON.parse('{"__proto__":["x"]}'))).toBeUndefined()
  })

  it('补丁保留空数组，合并时按 Agent 整份替换', () => {
    const patch = sanitizeHiddenModelsPatch({ claude: [] })
    expect(patch).toEqual({ claude: [] })
    expect(mergeHiddenModels({ claude: ['default'], codex: ['gpt-5'] }, patch)).toEqual({ codex: ['gpt-5'] })
    expect(mergeHiddenModels({ claude: ['default'] }, { claude: [] })).toBeUndefined()
    expect(mergeHiddenModels(undefined, { pi: ['a'] })).toEqual({ pi: ['a'] })
  })

  it('过滤隐藏模型，但保留当前选中项', () => {
    const models = [{ model: 'default' }, { model: 'opus' }, { model: 'haiku' }]
    expect(withoutHiddenModels(models, ['default', 'haiku']).map((m) => m.model)).toEqual(['opus'])
    expect(withoutHiddenModels(models, ['default', 'haiku'], 'haiku').map((m) => m.model)).toEqual(['opus', 'haiku'])
    expect(withoutHiddenModels(models, undefined)).toHaveLength(3)
  })

  it('切换隐藏状态', () => {
    expect(toggleHiddenModel(undefined, 'a')).toEqual(['a'])
    expect(toggleHiddenModel(['a', 'b'], 'a')).toEqual(['b'])
  })
})
