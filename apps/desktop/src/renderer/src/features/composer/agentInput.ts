// 发送前按 Agent 调整 turn/start 输入（纯逻辑）。

import type { UserInput } from '@qn/codex-client'

/** 与 Claude 桥 attachmentNote 同一格式，历史展示时 splitUserText 能拆回文件标签。 */
const ATTACHMENT_NOTE = '附件文件（请按需读取）：'

/** Codex v2 的 mention 用于 app / plugin 等资源（app://、plugin://），不是工作区文件。 */
const RESOURCE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Codex 的 `mention` 输入只承载 app/plugin 引用，模型看不到文件类 mention 的路径；
 * 所以文件附件对 Codex 改成正文末尾的路径说明（不读文件内容，由 Codex 自己按需读取）。
 * Claude / pi 的桥会自行把 mention 转成同样的说明，保持原样。
 */
export function adaptTurnInput(agent: string, input: UserInput[]): UserInput[] {
  if (agent !== 'codex') return input
  const files: { name: string; path: string }[] = []
  const rest: UserInput[] = []
  for (const item of input) {
    if (item.type === 'mention' && !RESOURCE_SCHEME.test(item.path)) files.push({ name: item.name || item.path, path: item.path })
    else rest.push(item)
  }
  if (files.length === 0) return input
  const note = `${ATTACHMENT_NOTE}\n${files.map((file) => `- ${file.name}: ${file.path}`).join('\n')}`
  const textIndex = rest.findIndex((item) => item.type === 'text')
  if (textIndex < 0) {
    // 没有正文时说明单独成为文本项，放在技能之后、图片之前，与 Claude 桥的顺序一致。
    const insertAt = rest.findIndex((item) => item.type !== 'skill')
    const noteItem: UserInput = { type: 'text', text: note, text_elements: [] }
    if (insertAt < 0) return [...rest, noteItem]
    return [...rest.slice(0, insertAt), noteItem, ...rest.slice(insertAt)]
  }
  return rest.map((item, index) =>
    index === textIndex && item.type === 'text' ? { ...item, text: `${item.text}\n\n${note}` } : item,
  )
}
