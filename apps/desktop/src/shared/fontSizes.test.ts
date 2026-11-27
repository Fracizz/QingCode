import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_SIZES, FONT_SIZES_VERSION, resolveFontSizes } from './fontSizes'

describe('resolveFontSizes', () => {
  it('旧版本文件里等于旧默认值的项跟随新默认，主动改过的值保留', () => {
    const resolved = resolveFontSizes({
      chatFontSize: 14,
      composerFontSize: 18,
      editorFontSize: 12.5,
      terminalFontSize: 13,
    })
    expect(resolved).toEqual({
      ...DEFAULT_FONT_SIZES,
      composerFontSize: 18,
      fontSizesVersion: FONT_SIZES_VERSION,
    })
  })

  it('当前版本文件里的值原样保留，即使恰好等于旧默认值', () => {
    expect(resolveFontSizes({ chatFontSize: 14, fontSizesVersion: FONT_SIZES_VERSION })).toEqual({
      ...DEFAULT_FONT_SIZES,
      chatFontSize: 14,
      fontSizesVersion: FONT_SIZES_VERSION,
    })
  })

  it('缺失或非法的字号回退默认', () => {
    expect(resolveFontSizes({ chatFontSize: 100, editorFontSize: '13' })).toEqual({
      ...DEFAULT_FONT_SIZES,
      fontSizesVersion: FONT_SIZES_VERSION,
    })
  })
})
