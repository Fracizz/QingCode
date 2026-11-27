import { describe, expect, it } from 'vitest'
import type { LanguageRegistration } from 'shiki/core'
import { CODE_THEMES } from './highlight'
import { createTokenizer } from './shikiCore'

describe('createTokenizer', () => {
  it('主题与语法经结构化克隆（postMessage 同款）后仍能着色', async () => {
    const [{ bundledThemes }, { bundledLanguages }] = await Promise.all([import('shiki/themes'), import('shiki/langs')])
    const themes = (await Promise.all([bundledThemes[CODE_THEMES.dark](), bundledThemes[CODE_THEMES.light]()])).map((m) => m.default)
    const grammar = (await bundledLanguages.typescript()).default as LanguageRegistration[]
    const tokenizer = createTokenizer(structuredClone(themes))

    expect(await tokenizer.tokenize('const a = 1', 'typescript')).toBeNull()
    const tokens = await tokenizer.tokenize('const a = 1', 'typescript', structuredClone(grammar))
    expect(tokens?.[0]?.map((token) => token.content).join('')).toBe('const a = 1')
    expect(tokens?.[0]?.[0]?.variants.dark?.color).toBeTruthy()
    // 语言已加载，后续请求不必再带语法。
    expect(await tokenizer.tokenize('let b', 'typescript')).not.toBeNull()
  })
})
