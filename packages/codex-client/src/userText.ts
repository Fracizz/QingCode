const ATTACHMENT_NOTE = '附件文件（请按需读取）：'
const SKILL_PREFIX = /^\/([\w.:-]+)(?:\s+|$)/

/** 桥接历史把附件和技能写入正文，先拆开才能只编辑用户输入。 */
export function splitUserText(text: string): { text: string; files: string[]; skills: string[] } {
  let body = text
  const files: string[] = []
  const index = body.lastIndexOf(ATTACHMENT_NOTE)
  if (index >= 0) {
    const lines = body.slice(index + ATTACHMENT_NOTE.length).split('\n').filter((line) => line.trim())
    const parsed = lines.map((line) => /^- [^:]*: (.+)$/.exec(line.trim())?.[1])
    if (parsed.length > 0 && parsed.every((path) => path !== undefined)) {
      files.push(...parsed)
      body = body.slice(0, index).replace(/\s+$/, '')
    }
  }
  const skills: string[] = []
  for (;;) {
    const match = SKILL_PREFIX.exec(body)
    if (!match) break
    skills.push(match[1]!)
    body = body.slice(match[0].length)
  }
  return { text: body, files, skills }
}

export function editUserText(original: string, text: string): string {
  const parsed = splitUserText(original)
  const body = [...parsed.skills.map((skill) => `/${skill}`), text].filter(Boolean).join(' ')
  if (!parsed.files.length) return body
  return `${body}\n\n${original.slice(original.lastIndexOf(ATTACHMENT_NOTE))}`.trim()
}
