// i18n-ignore: 写进发给模型的正文，也用于解析历史消息
const ATTACHMENT_NOTE = '附件文件（请按需读取）：'
// i18n-ignore: 写进发给模型的正文，也用于解析历史消息
const IMAGE_NOTE = '附图编号（按本条消息中图片的先后顺序）：'
const SKILL_PREFIX = /^\/([\w.:-]+)(?:\s+|$)/
const IMAGE_LINE = /^(\d+)\. \[([^\]\n]+)\]$/

/**
 * 图片随消息单独发送，模型看不到文件名；正文里引用了 `[名字]` 时追加编号说明，
 * 让模型把占位对应到第几张图。三种 Agent 都保留图片顺序，按序号对应最稳妥。
 */
export function appendImageNote(text: string, imageNames: readonly string[]): string {
  if (!imageNames.some((name) => text.includes(`[${name}]`))) return text
  const lines = imageNames.map((name, index) => `${index + 1}. [${name}]`).join('\n')
  return `${text}\n\n${IMAGE_NOTE}\n${lines}`
}

/** 正文末尾的说明段（附件 / 附图）：标题之后每行都要符合格式，否则视为用户原文。 */
function trailingNote<T>(body: string, title: string, parse: (line: string) => T | undefined): { body: string; items: T[] } | null {
  const index = body.lastIndexOf(title)
  if (index < 0) return null
  const lines = body.slice(index + title.length).split('\n').filter((line) => line.trim())
  const items = lines.map((line) => parse(line.trim()))
  if (items.length === 0 || items.some((item) => item === undefined)) return null
  return { body: body.slice(0, index).replace(/\s+$/, ''), items: items as T[] }
}

function splitNotes(text: string): { body: string; files: string[]; images: string[] } {
  let body = text
  // 附件说明由桥接或 adaptTurnInput 追加在最后，附图说明在它之前。
  const files = trailingNote(body, ATTACHMENT_NOTE, (line) => /^- [^:]*: (.+)$/.exec(line)?.[1])
  if (files) body = files.body
  const images = trailingNote(body, IMAGE_NOTE, (line) => IMAGE_LINE.exec(line)?.[2])
  if (images) body = images.body
  return { body, files: files?.items ?? [], images: images?.items ?? [] }
}

/** 桥接历史把附件、附图编号和技能写入正文，先拆开才能只编辑用户输入。 */
export function splitUserText(text: string): { text: string; files: string[]; skills: string[]; images: string[] } {
  const notes = splitNotes(text)
  let body = notes.body
  const skills: string[] = []
  for (;;) {
    const match = SKILL_PREFIX.exec(body)
    if (!match) break
    skills.push(match[1]!)
    body = body.slice(match[0].length)
  }
  return { text: body, files: notes.files, skills, images: notes.images }
}

export function editUserText(original: string, text: string): string {
  const parsed = splitUserText(original)
  const body = [...parsed.skills.map((skill) => `/${skill}`), text].filter(Boolean).join(' ')
  const notes = splitNotes(original)
  // 说明段原样保留，重新发送时图片与附件仍能对上编号和路径。
  const suffix = original.slice(notes.body.length).trim()
  return suffix ? `${body}\n\n${suffix}`.trim() : body
}
