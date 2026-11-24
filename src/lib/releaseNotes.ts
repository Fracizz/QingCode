/**
 * 发布说明按界面语言裁剪：GitHub / Gitee 发布正文是中英双语（`### English` 与 `### 中文` 两节，
 * 顶部带 `Language / 语言` 导航）。更新弹窗只保留当前语言那一节，避免中文界面先看到大段英文。
 * 手机端同一逻辑见 mobile/android/web/appUpdate.js 的 localizeReleaseNotes。
 */

const LANGUAGE_HEADING = /^#{1,6}[ \t]+(English|中文)[ \t]*#*[ \t]*$/gm
const LANGUAGE_NAV = /Language\s*\/\s*语言/i
const BLANK = /^\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const EMPTY_ANCHOR = /^\s*<a\s+id=(['"])[^'"]*\1\s*>\s*<\/a>\s*$/i

/** 去掉首尾的空行、分隔线和空 HTML 锚点。 */
function trimSeparators(text: string): string {
  const lines = text.split('\n')
  const junk = (line: string) => BLANK.test(line) || RULE.test(line) || EMPTY_ANCHOR.test(line)
  while (lines.length && junk(lines[0])) lines.shift()
  while (lines.length && junk(lines[lines.length - 1])) lines.pop()
  return lines.join('\n')
}

/** 中文界面（zh、zh-CN、zh-TW…）取「中文」节，其他语言取「English」节；非双语正文原样返回。 */
export function localizeReleaseNotes(body: string, language: string): string {
  const text = body.replace(/\r\n?/g, '\n')
  const headings = [...text.matchAll(LANGUAGE_HEADING)]
  const english = headings.find(match => match[1] === 'English')
  const chinese = headings.find(match => match[1] === '中文')
  if (!english || !chinese) return text

  const wanted = /^zh(?:$|[-_])/i.test(language) ? chinese : english
  const other = wanted === chinese ? english : chinese
  const start = wanted.index! + wanted[0].length
  const end = other.index! > wanted.index! ? other.index! : text.length
  const section = trimSeparators(text.slice(start, end))
  const prelude = trimSeparators(
    text
      .slice(0, Math.min(english.index!, chinese.index!))
      .split('\n')
      .filter(line => !LANGUAGE_NAV.test(line))
      .join('\n'),
  )
  return [prelude, section].filter(Boolean).join('\n\n')
}
