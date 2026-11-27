// 输入框附件（图片 / 文件）与斜杠菜单的纯逻辑。IO（读文件、压缩、上传）在 lib/attachmentIo.ts。

import type { UserInput } from '@qn/codex-client'

export const MAX_ATTACHMENTS = 8
/** 图片压缩后上限：随消息以 data URL 发送，太大会拖慢 turn/start 并占满上下文。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 超过这个边长的图片先缩放（模型侧也会缩，提前缩省带宽）。 */
export const IMAGE_MAX_EDGE = 2048
/** 普通文件上传上限：base64 后要放进 16 MiB 的单帧。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

export function isImageFile(file: { name: string; type: string }): boolean {
  return IMAGE_MIMES.has(file.type) || (!file.type && IMAGE_EXT.test(file.name))
}

export type ImageAttachment = {
  id: string
  kind: 'image'
  name: string
  size: number
  dataUrl: string
}

export type FileAttachment = {
  id: string
  kind: 'file'
  name: string
  size: number
  /** 本机真实路径（粘贴/拖入本机文件时有）。 */
  localPath: string
  /** 目标机上的路径：本机目标即 localPath，远端目标为上传后的路径。 */
  targetPath: string | null
  status: 'pending' | 'uploading' | 'ready' | 'error'
  error?: string
}

export type Attachment = ImageAttachment | FileAttachment

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0).replace(/\.0$/, '')} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

/** 上传到远端时的文件名：去掉路径分隔符、Windows 保留字符与控制字符，限制长度。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(-120)
  return cleaned || 'file'
}

/** 目标机是 Windows 还是 POSIX：看 home 路径的写法。 */
export function pathSeparator(home: string): '\\' | '/' {
  return /^[A-Za-z]:[\\/]/.test(home) || home.includes('\\') ? '\\' : '/'
}

/**
 * 远端上传位置：`<home>/.qingcode-next/uploads/<yyyymmdd>/<随机前缀>-<文件名>`。
 * 放在 home 下而不是项目里，避免把附件混进用户仓库。
 */
export function uploadPath(home: string, name: string, now: Date, random: string): string {
  const sep = pathSeparator(home)
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const base = home.replace(/[\\/]+$/, '')
  return [base, '.qingcode-next', 'uploads', day, `${random}-${sanitizeFileName(name)}`].join(sep)
}

export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : path
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export type SkillRef = { name: string; path: string }

/** 拼 turn/start 的 input：多个技能按选择顺序在最前（Claude 桥接会转成 /name 前缀），然后文字、图片、附件文件。 */
export function buildUserInput(text: string, attachments: Attachment[], skills: SkillRef[] = []): UserInput[] {
  const input: UserInput[] = []
  const seen = new Set<string>()
  for (const skill of skills) {
    // 同一技能重复选没有意义，还会让 prompt 里出现两遍 /name。
    if (!skill.name || seen.has(skill.name)) continue
    seen.add(skill.name)
    input.push({ type: 'skill', name: skill.name, path: skill.path })
  }
  if (text.trim()) input.push({ type: 'text', text, text_elements: [] })
  for (const item of attachments) {
    if (item.kind === 'image') input.push({ type: 'image', url: item.dataUrl })
  }
  for (const item of attachments) {
    if (item.kind === 'file' && item.status === 'ready' && item.targetPath) {
      input.push({ type: 'mention', name: item.name, path: item.targetPath })
    }
  }
  return input
}

/** 还有文件在上传或上传失败时不能发送，避免消息里漏掉附件。 */
export function attachmentsBlocking(attachments: Attachment[]): string | null {
  if (attachments.some((item) => item.kind === 'file' && (item.status === 'pending' || item.status === 'uploading'))) {
    return '附件上传中…'
  }
  if (attachments.some((item) => item.kind === 'file' && item.status === 'error')) return '有附件上传失败，请移除后再发送'
  return null
}

// ---------- 斜杠菜单 ----------

export type SlashToken = { query: string; start: number; end: number }

/**
 * 光标前的斜杠片段：`/` 在开头或空白之后即可，这样一条消息里能连续选多个技能。
 * 返回范围供选中后只删掉这一段，不吞掉已经输入的正文。
 */
export function slashToken(value: string, caret: number): SlashToken | null {
  const before = value.slice(0, caret)
  const after = value.slice(caret)
  // 光标停在词中间时不弹菜单，避免把后面的文字当成命令参数。
  if (after && !/^\s/.test(after)) return null
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before)
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: before.length - query.length - 1, end: caret }
}

export function slashQuery(value: string, caret: number): string | null {
  return slashToken(value, caret)?.query ?? null
}

/** 选中命令/技能后移除该斜杠片段，保留其余正文与换行。 */
export function consumeSlashToken(value: string, caret: number): string {
  const token = slashToken(value, caret)
  if (!token) return value
  const left = value.slice(0, token.start).replace(/[ \t]+$/, '')
  const right = value.slice(token.end).replace(/^[ \t]+/, '')
  if (!right) return left
  if (!left) return right
  return `${left}${left.endsWith('\n') ? '\n' : ' '}${right}`
}

export type SlashItem = {
  id: string
  kind: 'command' | 'skill'
  name: string
  description: string
  /** 技能来源（用户级 / 项目级 / 系统），仅展示。 */
  scope?: string
  path?: string
}

/** 排序：名称前缀匹配 > 名称包含 > 描述包含；同级内命令在技能之前、再按名称。 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  const rank = (item: SlashItem): number => {
    if (!q) return 0
    const name = item.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    if (item.description.toLowerCase().includes(q)) return 2
    return -1
  }
  return items
    .map((item) => ({ item, score: rank(item) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        a.score - b.score ||
        (a.item.kind === b.item.kind ? 0 : a.item.kind === 'command' ? -1 : 1) ||
        a.item.name.localeCompare(b.item.name),
    )
    .map((entry) => entry.item)
}

export { editUserText, splitUserText } from '@qn/codex-client'

