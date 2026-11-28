/**
 * Claude Code 以 user 身份写入、但并非用户原话的记录，以及套在用户原话外的标签（纯函数）。
 * 能按 SDK 字段识别的不匹配正文。
 */
import { asRecord, scalarText, type Json } from './v2'

function messageText(message: Json): string {
  const content = asRecord(message.message)?.content ?? message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map((block) => scalarText(asRecord(block)?.text)).join('\n').trim()
}

/** 子代理回报与跨会话消息：取干净正文，去掉给模型看的说明和标签。 */
export function peerMessage(message: Json): { sender: string; body: string } | undefined {
  const origin = asRecord(message.origin)
  if (origin?.kind !== 'peer') return undefined
  const text = messageText(message)
  const wrapped = /<(agent-message|cross-session-message)\b[^>]*>([\s\S]*)<\/\1>/.exec(text)?.[2]
  const body = (scalarText(origin.handbackReportText) || scalarText(origin.body) || wrapped || text).trim()
  return body ? { sender: scalarText(origin.name), body } : undefined
}

/** 分叉会话时写入的背景说明，没有对应的后台任务。 */
export function isForkNotice(message: Json): boolean {
  if (asRecord(message.origin)?.kind !== 'task-notification') return false
  return /^<task-notification>\s*<fork-source>[\s\S]*<\/fork-source>\s*<\/task-notification>$/.test(messageText(message))
}

// 闭合标签带同一个 id，用户手写的相似文字不会被误删。
const PASTED = /<pasted_content id="([^"]*)">\r?\n?([\s\S]*?)\r?\n?<\/pasted_content id="\1">/g

/** 终端里粘贴的大段内容会套上 pasted_content 标签，展示时只留内容。 */
export function unwrapPasted(text: string): string {
  return text.replace(PASTED, (_match, _id, body: string) => body)
}
