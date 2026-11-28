import { appendImageNote } from './userText'

const NAME_LENGTH = 20
const HEAD_LENGTH = 8
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null

function splitFileName(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 && /^\.[a-z\d]{1,7}$/i.test(name.slice(dot)) ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

function fullPlaceholder(name: string): string {
  return `[${name.replace(/[\r\n]+/g, ' ')}]`
}

/** 缩短可编辑的标签，预览和发送仍能通过附件取到完整名称。 */
export function imagePlaceholder(name: string): string {
  const normalized = name.replace(/[\r\n]+/g, ' ')
  const [stem, extension] = splitFileName(normalized)
  const characters = segmenter ? Array.from(segmenter.segment(stem), ({ segment }) => segment) : Array.from(stem)
  if (characters.length + extension.length <= NAME_LENGTH) return `[${normalized}]`
  const tail = NAME_LENGTH - HEAD_LENGTH - 1 - extension.length
  return `[${characters.slice(0, HEAD_LENGTH).join('')}…${characters.slice(-tail).join('')}${extension}]`
}

export function uniqueImageName(name: string, taken: Iterable<string>): string {
  // 不同全名也可能显示成同一个标签，需要按显示名去重。
  const used = new Set(Array.from(taken, imagePlaceholder))
  const base = name || 'image.png'
  const [stem, extension] = splitFileName(base)
  let candidate = base
  for (let index = 2; used.has(imagePlaceholder(candidate)); index++) candidate = `${stem}-${index}${extension}`
  return candidate
}

/** 用 text 替换 [start, end) 选区，按需要补空格。 */
export function insertAtSelection(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const left = value.slice(0, start)
  const right = value.slice(end)
  const before = left && !/\s$/.test(left) ? ' ' : ''
  const after = right && !/^\s/.test(right) ? ' ' : ''
  const inserted = `${before}${text}${after}`
  return { value: left + inserted + right, caret: left.length + inserted.length }
}

export function insertImagePlaceholders(
  value: string,
  names: readonly string[],
  selection = { start: value.length, end: value.length },
  pastedText = '',
): { value: string; caret: number } {
  const { start, end } = selection
  // 剪贴板同时有文件和文字时，先插入文字，再接上图片名。
  const plain = pastedText.replace(/\r\n?/g, '\n')
  const nextText = plain ? value.slice(0, start) + plain + value.slice(end) : value
  const position = start + plain.length
  if (!names.length) return { value: nextText, caret: position }
  return insertAtSelection(nextText, position, plain ? position : end, names.map(imagePlaceholder).join(' '))
}

/** 去掉对应的占位及分隔空格，保留原有换行。 */
export function removePlaceholder(value: string, name: string): string {
  const token = imagePlaceholder(name)
  for (let index = value.indexOf(token); index >= 0; index = value.indexOf(token)) {
    let end = index + token.length
    if (value[end] === ' ') end++
    else if (value[index - 1] === ' ') index--
    value = value.slice(0, index) + value.slice(end)
  }
  return value
}

export function stripAttachmentPlaceholders(value: string, attachments: readonly { name: string }[]): string {
  for (const item of attachments) value = removePlaceholder(value, item.name)
  return value
}

export function attachmentTextPattern(tokens: Iterable<string>): RegExp | null {
  const escaped = [...tokens].sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return escaped.length ? new RegExp(`(${escaped.join('|')})`) : null
}

/** 有正文时还原标签全名，并让模型能按编号找到引用的图片。 */
export function composeAttachmentText(
  value: string,
  attachments: readonly { name: string }[],
  images: readonly { name: string }[] = attachments,
): string {
  if (!stripAttachmentPlaceholders(value, attachments).trim()) return ''
  const labels = new Map(attachments.map(({ name }) => [imagePlaceholder(name), fullPlaceholder(name)]))
  const pattern = attachmentTextPattern(labels.keys())
  const text = pattern ? value.split(pattern).map((part, index) => index % 2 ? labels.get(part) ?? part : part).join('') : value
  return appendImageNote(text, images.map(({ name }) => name.replace(/[\r\n]+/g, ' ')))
}
