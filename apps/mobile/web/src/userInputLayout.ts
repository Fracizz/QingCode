// 提问卡片选项排版的纯逻辑：短选项两列并排，省出高度；有一项偏长就整体单列，避免一行高一行矮。

type OptionText = { label: string; description?: string }

// 按显示宽度估算：中日韩等全角字符记 2，其余记 1。手机两列时每格约容纳 16 个半角宽度。
const LABEL_LIMIT = 16
const DESCRIPTION_LIMIT = 24

export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1
  return width
}

/** 选项是否都短到可以两列排布；少于 2 个选项时没有意义。 */
export function twoColumnOptions(options: readonly OptionText[]): boolean {
  if (options.length < 2) return false
  return options.every((option) => textWidth(option.label.trim()) <= LABEL_LIMIT
    && textWidth(option.description?.trim() ?? '') <= DESCRIPTION_LIMIT)
}
