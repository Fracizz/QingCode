// 图片附件的纯逻辑：文件筛选、data URL 解析与校验、按模型输入模态判断能否发图。
import { MAX_FRAME_BYTES } from '@qn/protocol'
import type { UserInput } from '@qn/codex-client'
import { t } from '@qn/codex-client'

/** 单张图片上限（按解码后字节数）；与 server 侧 Claude/pi 映射的上限一致。 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 8
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

const MIME_SET = new Set<string>(IMAGE_MIME_TYPES)
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
// 给 JSON-RPC 外层、会话 ID 和模型/权限参数留出空间。
const MAX_TURN_INPUT_BYTES = MAX_FRAME_BYTES - 8 * 1024
const OVERSIZE_TURN_INPUT = t('消息和附件编码后超过传输上限，请移除部分内容后再发送')

type FileLike = { name: string; type: string; size: number }

/** 判定口径与聊天区附件流程（lib/attachments 的 isImageFile）一致：bmp/svg 等按普通文件处理。 */
export function isSupportedImage(file: { name: string; type: string }): boolean {
  return MIME_SET.has(file.type.toLowerCase()) || (!file.type && IMAGE_EXT.test(file.name))
}

export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB`
}

export type ScreenResult<T> = { accepted: T[]; rejected: { name: string; reason: string }[] }

/**
 * 附件入口先筛一遍图片：类型、大小、张数、当前模型是否支持图片。
 * 非图片文件原样放行（由附件流程按文件处理）。被拒的逐个给出原因，调用方负责提示，不静默丢弃。
 */
export function screenFiles<T extends FileLike>(
  files: T[],
  options: { existingImages: number; imagesAllowed: boolean; unsupportedReason?: string },
): ScreenResult<T> {
  const accepted: T[] = []
  const rejected: { name: string; reason: string }[] = []
  let images = options.existingImages
  for (const file of files) {
    const name = file.name || t('粘贴的图片')
    if (!isSupportedImage(file)) {
      accepted.push(file)
      continue
    }
    if (!options.imagesAllowed) {
      rejected.push({ name, reason: options.unsupportedReason ?? t('当前模型不支持图片输入') })
      continue
    }
    if (file.size > IMAGE_MAX_BYTES) {
      rejected.push({ name, reason: t('图片超过 {limit}（{size}）', { limit: formatMiB(IMAGE_MAX_BYTES), size: formatMiB(file.size) }) })
      continue
    }
    if (images >= MAX_IMAGES) {
      rejected.push({ name, reason: t('一条消息最多 {count} 张图片', { count: MAX_IMAGES }) })
      continue
    }
    images += 1
    accepted.push(file)
  }
  return { accepted, rejected }
}

export type ParsedDataUrl = { mimeType: string; data: string; bytes: number }

/** 只接受 base64 data URL；mimeType 小写，bytes 为不解码估算的原始字节数。 */
export function parseImageDataUrl(url: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+)((?:;[^;,]+)*);base64,([\s\S]*)$/i.exec(url)
  if (!match) return null
  const data = (match[3] ?? '').replace(/\s+/g, '')
  return { mimeType: (match[1] ?? '').toLowerCase(), data, bytes: base64Bytes(data) }
}

export function base64Bytes(data: string): number {
  if (!data) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/** 单张已读入的图片能否发送；返回原因或 null。 */
export function imageDataUrlProblem(url: string): string | null {
  const parsed = parseImageDataUrl(url)
  if (!parsed) return t('图片数据无效')
  if (!MIME_SET.has(parsed.mimeType)) return t('不支持的图片类型 {type}', { type: parsed.mimeType })
  if (parsed.bytes > IMAGE_MAX_BYTES) return t('图片超过 {limit}', { limit: formatMiB(IMAGE_MAX_BYTES) })
  return null
}

/**
 * 发送前再校验一次，因为添加图片后仍可能切换模型。
 * 返回阻止发送的原因；模型不支持图片时同样阻止，让用户自己移除，而不是悄悄丢掉。
 */
export function imageSendBlock(dataUrls: string[], imagesAllowed: boolean, unsupportedReason?: string): string | null {
  if (dataUrls.length === 0) return null
  if (!imagesAllowed) return t('{reason}，请移除图片后再发送', { reason: unsupportedReason ?? t('当前模型不支持图片输入') })
  if (dataUrls.length > MAX_IMAGES) return t('一条消息最多 {count} 张图片，请移除多余的图片', { count: MAX_IMAGES })
  for (const url of dataUrls) {
    const problem = imageDataUrlProblem(url)
    if (problem) return t('{problem}，请移除后再发送', { problem })
  }
  if (dataUrls.reduce((sum, url) => sum + url.length, 0) > MAX_TURN_INPUT_BYTES) return OVERSIZE_TURN_INPUT
  return turnInputSizeProblem(dataUrls.map((url) => ({ type: 'image', url })))
}

export function turnInputSizeProblem(input: readonly UserInput[]): string | null {
  const json = JSON.stringify(input)
  const tooLarge = json.length > MAX_TURN_INPUT_BYTES || new TextEncoder().encode(json).byteLength > MAX_TURN_INPUT_BYTES
  return tooLarge ? OVERSIZE_TURN_INPUT : null
}

// ---------- 模型输入模态 ----------

/** model id → 输入模态；null 表示该模型没有声明（不能据此判断不支持）。 */
export type ModalityTable = { models: Record<string, string[] | null>; defaultModel: string | null }

/** 从 model/list 原始结果提取 inputModalities（ModelOption 不保留这个字段）。 */
export function modalityTable(raw: unknown): ModalityTable {
  const models: Record<string, string[] | null> = {}
  let defaultModel: string | null = null
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.model === 'string' && record.model ? record.model : typeof record.id === 'string' ? record.id : ''
    if (!id) continue
    const modalities = Array.isArray(record.inputModalities)
      ? record.inputModalities.filter((item): item is string => typeof item === 'string')
      : null
    models[id] = modalities
    if (record.isDefault === true && defaultModel === null) defaultModel = id
  }
  return { models, defaultModel }
}

export type ImageSupport = { allowed: boolean; reason: string | null }

const ALLOWED: ImageSupport = { allowed: true, reason: null }

/**
 * 只有模型明确声明了输入模态且不含 image 时才禁用；没声明、没取到列表都按允许处理，
 * 由 Agent 自己报错（不替 Agent 编造"不支持"）。
 */
export function imageSupportFor(table: ModalityTable | null, model: string | null, modelName?: string): ImageSupport {
  if (!table) return ALLOWED
  const id = model ?? table.defaultModel
  if (!id) return ALLOWED
  const modalities = table.models[id]
  if (!modalities || modalities.length === 0) return ALLOWED
  if (modalities.includes('image')) return ALLOWED
  return { allowed: false, reason: modelName ? t('当前模型 {model} 不支持图片输入', { model: modelName }) : t('当前模型不支持图片输入') }
}
