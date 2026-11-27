import { t, type ItemView } from '@qn/codex-client'

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
  return count === 1 ? t('💬 1 条注释') : t('💬 {count} 条注释', { count })
}

export function annotationExcerpt(annotation: Annotation, limit = 120): string {
  const text = annotation.quote.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 预填的上下文限于同一轮，用户发送前可以删改。 */
export function sideChatExcerpt(items: readonly ItemView[], selection?: { text: string; itemId?: string }): string {
  const sourceIndex = selection ? items.findIndex((item) => item.id === selection.itemId) : items.length
  if (selection && (sourceIndex < 0 || items[sourceIndex]?.kind === 'user')) return selection.text
  const questionIndex = items.slice(0, sourceIndex).findLastIndex((item) => item.kind === 'user')
  const question = items[questionIndex]
  const blocks: string[] = []
  if (question?.kind === 'user') blocks.push('本轮问题：' + question.text.slice(0, 600)) // i18n-ignore: 随消息发给模型
  if (selection) {
    blocks.push('所选片段：\n' + selection.text) // i18n-ignore: 随消息发给模型
  } else {
    const answer = items.slice(questionIndex + 1).findLast((item) => item.kind === 'agent')
    if (answer?.kind === 'agent') blocks.push('回复摘录：\n' + answer.text.slice(0, 800)) // i18n-ignore: 随消息发给模型
  }
  return blocks.join('\n\n')
}
