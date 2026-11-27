// 技能直接以 `/名字` 文本显示在输入框里，发送时再拆成 skill 输入（纯逻辑，桌面与手机共用）。

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function tokenPattern(name: string): RegExp {
  // 前面是开头或空白，后面是空白或结尾，才算完整的技能标记，避免误吞路径里的片段。
  return new RegExp(`(^|\\s)/${escapeRegExp(name)}(?:[ \\t]+|(?=\\s)|$)`)
}

/**
 * 用技能标记替换 [start, end) 这段斜杠查询，左右各留一个空格与正文隔开。
 * 返回新文本和光标位置（落在标记后的空格之后，可直接继续输入）。
 */
export function insertSkillToken(value: string, start: number, end: number, name: string): { text: string; caret: number } {
  const left = value.slice(0, start)
  const right = value.slice(end).replace(/^[ \t]+/, '')
  const before = left && !/\s$/.test(left) ? ' ' : ''
  const head = `${left}${before}/${name} `
  return { text: head + right, caret: head.length }
}

export function hasSkillToken(text: string, name: string): boolean {
  return Boolean(name) && tokenPattern(name).test(text)
}

/**
 * 找出正文里仍保留的已选技能并移除对应标记；用户手动删掉标记的技能不再发送。
 * 没有技能标记时正文原样返回。
 */
export function takeSkillTokens<T extends { name: string }>(text: string, picked: readonly T[]): { text: string; skills: T[] } {
  const skills: T[] = []
  const seen = new Set<string>()
  let body = text
  for (const skill of picked) {
    if (!skill.name || seen.has(skill.name)) continue
    const pattern = tokenPattern(skill.name)
    if (!pattern.test(body)) continue
    seen.add(skill.name)
    skills.push(skill)
    // 同一技能写了多次也只发送一次，标记全部移除。
    while (pattern.test(body)) body = body.replace(pattern, '$1')
  }
  return { text: skills.length ? body.trim() : text, skills }
}
