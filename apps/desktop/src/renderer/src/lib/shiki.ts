import type { HighlighterCore, ThemedTokenWithVariants } from 'shiki/core'

// shiki 只在第一次遇到代码块时按需加载：核心 + 主题 + 用到的语言语法各自是独立 chunk，不拖慢启动。
// 用 JavaScript 正则引擎而不是 oniguruma（WASM），CSP 不需要放开 wasm-unsafe-eval。

// 深色/灰色用 dark，浅色用 light；一次着色同时拿到两套颜色，切主题只换 CSS 变量。
export const CODE_THEMES = { dark: 'github-dark-default', light: 'github-light-default' } as const

let core: Promise<HighlighterCore> | null = null

async function getCore(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes'),
    ])
    return createHighlighterCore({
      themes: [bundledThemes[CODE_THEMES.dark], bundledThemes[CODE_THEMES.light]],
      langs: [],
      // forgiving：个别语法里引擎不支持的正则直接跳过，宁可少高亮也不抛错。
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
  })()
  return core
}

/** 返回按行分组的着色 token（每个 token 带 dark/light 两套样式）；语言不在 shiki 内置列表或加载失败时返回 null（调用方按纯文本显示）。 */
export async function highlightTokens(code: string, lang: string): Promise<ThemedTokenWithVariants[][] | null> {
  try {
    const { bundledLanguages } = await import('shiki/langs')
    const loader = (bundledLanguages as Record<string, unknown>)[lang]
    if (!loader) return null
    const highlighter = await getCore()
    if (!highlighter.getLoadedLanguages().includes(lang)) {
      await highlighter.loadLanguage(loader as Parameters<HighlighterCore['loadLanguage']>[0])
    }
    return highlighter.codeToTokensWithThemes(code, { lang, themes: CODE_THEMES })
  } catch {
    return null
  }
}
