// 附件 IO：读图片并按需压缩、把文件上传到目标机。纯逻辑在 lib/attachments.ts。

import { t } from '@qn/codex-client'
import { serverCall } from '../features/workspace/serverCall'
import { call } from './backend'
import { dirname, IMAGE_MAX_EDGE, MAX_IMAGE_BYTES, uploadPath } from './attachments'

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error(t('读取文件失败')))
    reader.readAsDataURL(blob)
  })
}

/** data URL 的实际字节数（base64 部分 × 3/4）。 */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}

/**
 * 读图片为 data URL：边长超过 IMAGE_MAX_EDGE 或体积超过上限时用 canvas 缩放并转 WebP。
 * GIF 缩放会丢动画，只在超限时才转。
 */
export async function readImage(file: File): Promise<{ dataUrl: string; size: number }> {
  const original = await readAsDataUrl(file)
  const bitmap = await createImageBitmap(file).catch(() => null)
  const tooLarge = file.size > MAX_IMAGE_BYTES
  const tooWide = bitmap ? Math.max(bitmap.width, bitmap.height) > IMAGE_MAX_EDGE : false
  if (!bitmap || (!tooLarge && !tooWide)) {
    bitmap?.close()
    if (tooLarge) throw new Error(t('图片超过 {size} MB，且无法压缩', { size: MAX_IMAGE_BYTES / 1024 / 1024 }))
    return { dataUrl: original, size: file.size }
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  for (const quality of [0.9, 0.8, 0.65, 0.5]) {
    const dataUrl = canvas.toDataURL('image/webp', quality)
    const size = dataUrlBytes(dataUrl)
    if (size <= MAX_IMAGE_BYTES) return { dataUrl, size }
  }
  throw new Error(t('图片压缩后仍然过大'))
}

const homes = new Map<string, Promise<string>>()

/** 目标机的 home 目录（按目标缓存；失败时清缓存以便重试）。 */
function targetHome(targetId: string): Promise<string> {
  let home = homes.get(targetId)
  if (!home) {
    home = call('server.req', { targetId, method: 'fs.home', params: {} }).then((result) => {
      const path = (result as { path?: unknown } | null)?.path
      if (typeof path !== 'string' || !path) throw new Error(t('无法获取目标机 home 目录'))
      return path
    })
    home.catch(() => homes.delete(targetId))
    homes.set(targetId, home)
  }
  return home
}

/** 把本机文件上传到目标机的附件目录，返回目标机上的绝对路径。 */
export async function uploadToTarget(targetId: string, file: File): Promise<string> {
  const home = await targetHome(targetId)
  const random = Math.random().toString(36).slice(2, 8)
  const path = uploadPath(home, file.name, new Date(), random)
  const dataUrl = await readAsDataUrl(file)
  const content = dataUrl.slice(dataUrl.indexOf(',') + 1)
  await serverCall(targetId, 'fs.mkdir', { path: dirname(path) })
  await serverCall(targetId, 'fs.write', { path, content, encoding: 'base64', create: true })
  return path
}
