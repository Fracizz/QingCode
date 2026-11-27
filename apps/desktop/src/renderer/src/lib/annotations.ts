export type Annotation = {
  id: string
  quote: string
  comment: string
}

/** 引用逐行加 "> "，空行也保留，避免多行引用被 Markdown 合并。 */
export function quoteBlock(quote: string): string {
  return quote
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * 发送时把注释按 §12 的格式拼到用户输入前面；没有注释时保持原文，
 * 只有注释没有输入时也能单独发送引用。
 */
export function buildAnnotatedMessage(annotations: readonly Annotation[], input: string): string {
  const body = input.trim()
  const blocks = annotations
    .map((annotation) => {
      const selected = annotation.quote.trim()
      if (!selected) return ''
      const quote = quoteBlock(selected)
      const comment = annotation.comment.trim()
      return comment ? `${quote}\n${comment}` : quote
    })
    .filter((block) => block !== '')
  if (blocks.length === 0) return body
  const prefix = blocks.join('\n\n')
  return body ? `${prefix}\n\n${body}` : prefix
}

export function annotationLabel(count: number): string {
  return `💬 ${count} 条注释`
}

export function annotationExcerpt(annotation: Annotation, limit = 120): string {
  const text = annotation.quote.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
