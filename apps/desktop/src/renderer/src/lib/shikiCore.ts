import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedTokenWithVariants, type ThemeRegistrationAny } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { CODE_THEMES } from './highlight'

export type HighlightTokens = ThemedTokenWithVariants[][]

/**
 * 着色器核心：Worker 和主线程兜底共用。语法、主题都由调用方传入现成对象，
 * 这样 Worker 只打包 shiki 核心，不会把全部语言语法内联进 Worker 产物。
 * 用 JavaScript 正则引擎而不是 oniguruma（WASM），CSP 不需要放开 wasm-unsafe-eval。
 */
export function createTokenizer(themes: ThemeRegistrationAny[]) {
  let core: Promise<HighlighterCore> | null = null
  const getCore = () => core ??= createHighlighterCore({
    themes,
    langs: [],
    // forgiving：个别语法里引擎不支持的正则直接跳过，宁可少高亮也不抛错。
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })

  return {
    async tokenize(code: string, lang: string, grammars?: LanguageRegistration[]): Promise<HighlightTokens | null> {
      try {
        const highlighter = await getCore()
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          if (!grammars?.length) return null
          await highlighter.loadLanguage(...grammars)
        }
        return highlighter.codeToTokensWithThemes(code, { lang, themes: CODE_THEMES })
      } catch {
        return null
      }
    },
  }
}
