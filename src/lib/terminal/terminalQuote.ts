/**
 * 终端右键「添加到对话」：把选中的终端文本转成 Markdown 引用，粘贴回 Claude Code / opencode
 * 等 AI CLI 的输入框，用户接着补充问题后自己发送（不自动回车）。
 */

/** 生成引用文本；选区为空白时返回空串。末尾带换行，光标落在引用下方的新行。 */
export function formatTerminalQuote(selection: string): string {
  const lines = selection
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // xterm 选区按网格取文本，行尾常带填充空格。
    .map(line => line.replace(/\s+$/, ''))
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  if (!lines.length) return ''
  return `${lines.map(line => (line ? `> ${line}` : '>')).join('\n')}\n\n`
}
