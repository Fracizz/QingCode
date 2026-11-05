/**
 * 超大文本粘贴判断。
 *
 * 经 ConPTY 把十几万字符一次灌进 Claude Code 等 TUI 时，对方要逐个解析输入事件并反复重绘，
 * 终端会卡住数秒且 Ctrl+C 排在后面无法中断。超过阈值时改为询问：存为文件只粘贴路径，
 * 或仍然直接粘贴。
 */
export const LARGE_PASTE_MAX_CHARS = 32 * 1024
export const LARGE_PASTE_MAX_LINES = 500

export interface LargePasteStats {
  chars: number
  lines: number
}

/** 超过字符数或行数阈值时返回统计，否则返回 null。 */
export function largePasteStats(text: string): LargePasteStats | null {
  const chars = text.length
  let lines = 1
  for (let i = 0; i < chars; i++) {
    const code = text.charCodeAt(i)
    // \r\n 只算一行；单独的 \r 或 \n 各算一行。
    if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) lines++
  }
  if (text.endsWith('\n') || text.endsWith('\r')) lines--
  if (chars <= LARGE_PASTE_MAX_CHARS && lines <= LARGE_PASTE_MAX_LINES) return null
  return { chars, lines }
}

/** 保存粘贴文本时使用的文件名，如 pasted-text-20261105-021530.txt。 */
export function largePasteFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-text-${date}-${time}.txt`
}

/** 对话框里展示的体积，如 160 KB / 1.2 MB。 */
export function formatPasteSize(chars: number): string {
  if (chars < 1024 * 1024) return `${Math.max(1, Math.round(chars / 1024))} KB`
  return `${(chars / 1024 / 1024).toFixed(1)} MB`
}
