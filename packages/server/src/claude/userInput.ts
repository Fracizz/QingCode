/**
 * turn/start 的 UserInput[] → Anthropic 内容块。
 * 纯逻辑（解析、data URL、media_type、内容块构造、历史还原）与 IO（读 localImage）分开：
 * parseTurnInput 不碰文件系统，loadLocalImage 通过可注入的 io 读盘。
 */
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { BridgeRpcError } from './errors'
import { asRecord, scalarText, type Json } from './v2'

/** Anthropic 单张图片上限按解码后字节数计；超过直接拒绝，避免整轮请求被 API 退回。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const SUPPORTED_MEDIA_TYPES = new Set(Object.values(MEDIA_TYPE_BY_EXT))

export type ImageRef =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string }

export interface ParsedTurnInput {
  texts: string[]
  /** skill 输入对应的斜杠命令名，按出现顺序。 */
  skills: string[]
  images: ImageRef[]
  mentions: { name: string; path: string }[]
}

export type ImageBlock = {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}
export type TextBlock = { type: 'text'; text: string }
export type ContentBlock = ImageBlock | TextBlock

export interface TurnContent {
  /** 给 SDK 的内容块（图片在前，文本在后）。 */
  blocks: ContentBlock[]
  /** 给客户端回显的 userMessage.content。 */
  echo: Json[]
  /** 文本块全文（含斜杠前缀与附件说明）。 */
  text: string
}

export function imageMediaTypeFromPath(path: string): string | null {
  return MEDIA_TYPE_BY_EXT[extname(path).toLowerCase()] ?? null
}

export function isSupportedMediaType(mediaType: string): boolean {
  return SUPPORTED_MEDIA_TYPES.has(mediaType.toLowerCase())
}

/** 只接受 base64 data URL；media_type 统一小写。 */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+)((?:;[^;,]+)*);base64,([\s\S]*)$/i.exec(url)
  if (!match) return null
  return { mediaType: (match[1] ?? '').toLowerCase(), data: (match[3] ?? '').replace(/\s+/g, '') }
}

/** 不解码就估算 base64 解码后的字节数。 */
export function base64DecodedLength(data: string): number {
  if (!data) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function imageTooLarge(): BridgeRpcError {
  return new BridgeRpcError(-32602, `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MiB 上限`)
}

function checkMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase()
  if (!isSupportedMediaType(normalized)) {
    throw new BridgeRpcError(
      -32602,
      `不支持的图片类型 ${normalized || '(空)'}，仅支持 png/jpeg/gif/webp`,
    )
  }
  return normalized
}

/** 解析 UserInput[]：校验图片并分类，不读文件。 */
export function parseTurnInput(input: unknown): ParsedTurnInput {
  const out: ParsedTurnInput = { texts: [], skills: [], images: [], mentions: [] }
  if (!Array.isArray(input)) return out
  for (const entry of input) {
    const record = asRecord(entry)
    if (!record) continue
    switch (record.type) {
      case 'text': {
        const text = scalarText(record.text)
        if (text) out.texts.push(text)
        break
      }
      case 'skill': {
        const name = scalarText(record.name).trim().replace(/^\/+/, '')
        if (name) out.skills.push(name)
        break
      }
      case 'image': {
        const url = scalarText(record.url).trim()
        if (!url) throw new BridgeRpcError(-32602, '图片缺少 url')
        if (/^data:/i.test(url)) {
          const parsed = parseDataUrl(url)
          if (!parsed) throw new BridgeRpcError(-32602, '图片 data URL 格式无效，需要 base64 编码')
          const mediaType = checkMediaType(parsed.mediaType)
          if (base64DecodedLength(parsed.data) > MAX_IMAGE_BYTES) throw imageTooLarge()
          out.images.push({ kind: 'base64', mediaType, data: parsed.data })
        } else if (/^https?:\/\//i.test(url)) {
          out.images.push({ kind: 'url', url })
        } else {
          throw new BridgeRpcError(-32602, '图片 url 仅支持 data: 与 http(s):')
        }
        break
      }
      case 'localImage': {
        const path = scalarText(record.path)
        if (!path) throw new BridgeRpcError(-32602, '本地图片缺少 path')
        out.images.push({ kind: 'file', path })
        break
      }
      case 'mention': {
        const path = scalarText(record.path)
        if (!path) break
        out.mentions.push({ name: scalarText(record.name) || path, path })
        break
      }
      default:
        break
    }
  }
  return out
}

export interface LocalImageIo {
  size(path: string): Promise<number>
  read(path: string): Promise<Buffer>
}

const defaultIo: LocalImageIo = {
  size: async (path) => (await stat(path)).size,
  read: (path) => readFile(path),
}

/** 读本地图片并转 base64；先 stat 再读，避免把超大文件整个载入内存。 */
export async function loadLocalImage(
  path: string,
  io: LocalImageIo = defaultIo,
): Promise<{ mediaType: string; data: string }> {
  const mediaType = imageMediaTypeFromPath(path)
  if (!mediaType) {
    throw new BridgeRpcError(-32602, `不支持的图片类型 ${extname(path) || '(无扩展名)'}：${path}`)
  }
  let buffer: Buffer
  try {
    if ((await io.size(path)) > MAX_IMAGE_BYTES) throw imageTooLarge()
    buffer = await io.read(path)
  } catch (err) {
    if (err instanceof BridgeRpcError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new BridgeRpcError(-32602, `无法读取本地图片 ${path}：${reason}`)
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw imageTooLarge()
  return { mediaType, data: buffer.toString('base64') }
}

/** mention 不读内容，只在文本末尾列出路径，让 Claude 按需用工具读取。 */
export function attachmentNote(mentions: { name: string; path: string }[]): string {
  if (mentions.length === 0) return ''
  // i18n-ignore: 发给模型的提示词
  return `附件文件（请按需读取）：\n${mentions.map((m) => `- ${m.name}: ${m.path}`).join('\n')}`
}

export function imageDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`
}

/** 纯函数：已解析输入 + 已读取的本地图片 → 内容块与回显。files 按 images 中 file 项的出现顺序给出。 */
export function buildTurnContent(
  parsed: ParsedTurnInput,
  files: { mediaType: string; data: string }[] = [],
): TurnContent {
  const blocks: ContentBlock[] = []
  const echo: Json[] = []
  let fileIndex = 0
  for (const image of parsed.images) {
    if (image.kind === 'url') {
      blocks.push({ type: 'image', source: { type: 'url', url: image.url } })
      echo.push({ type: 'image', url: image.url })
      continue
    }
    const resolved = image.kind === 'base64' ? image : files[fileIndex++]
    if (!resolved) throw new BridgeRpcError(-32603, '本地图片内容缺失')
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: resolved.mediaType, data: resolved.data },
    })
    echo.push({ type: 'image', url: imageDataUrl(resolved.mediaType, resolved.data) })
  }
  // Claude Code 原生识别以斜杠开头的命令，所以 skill 必须排在 prompt 文本最前面。
  const prefix = parsed.skills.map((name) => `/${name}`).join(' ')
  const body = [prefix, parsed.texts.join('\n')].filter(Boolean).join(' ')
  const note = attachmentNote(parsed.mentions)
  const text = body && note ? `${body}\n\n${note}` : body || note
  if (text) {
    blocks.push({ type: 'text', text })
    echo.push({ type: 'text', text, text_elements: [] })
  }
  return { blocks, echo, text }
}

/** 解析并读取所有本地图片，返回可直接发给 SDK 的内容；没有任何有效内容时抛错。 */
export async function resolveTurnInput(
  input: unknown,
  io: LocalImageIo = defaultIo,
): Promise<TurnContent> {
  const parsed = parseTurnInput(input)
  const files: { mediaType: string; data: string }[] = []
  for (const image of parsed.images) {
    if (image.kind === 'file') files.push(await loadLocalImage(image.path, io))
  }
  const content = buildTurnContent(parsed, files)
  if (content.blocks.length === 0) {
    throw new BridgeRpcError(-32602, 'turn/start 需要文本、图片或附件')
  }
  return content
}

/** 历史里的 Anthropic 图片块 → v2 userMessage 的 image 项；无法还原返回 null。 */
export function imageBlockToEcho(block: unknown): Json | null {
  const record = asRecord(block)
  if (!record || record.type !== 'image') return null
  const source = asRecord(record.source)
  if (!source) return null
  if (source.type === 'base64') {
    const mediaType = scalarText(source.media_type)
    const data = scalarText(source.data)
    return mediaType && data ? { type: 'image', url: imageDataUrl(mediaType, data) } : null
  }
  if (source.type === 'url') {
    const url = scalarText(source.url)
    return url ? { type: 'image', url } : null
  }
  return null
}
