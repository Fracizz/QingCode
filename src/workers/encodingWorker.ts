/**
 * Encoding Worker - 在 Web Worker 中执行编码检测
 *
 * 使用场景：
 * - 大文件编码检测时避免阻塞主线程
 * - 批量文件编码检测
 */

export interface EncodingWorkerRequest {
  id: number
  /** 文件路径 */
  path: string
  /** 文件内容的前 N 个字节（Base64 编码） */
  bytesBase64: string
}

export interface EncodingWorkerResponse {
  id: number
  success: boolean
  /** 检测到的编码 */
  encoding?: string
  /** 错误信息 */
  error?: string
}

/** Base64 解码为 Uint8Array */
function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

/** 检测 BOM（须先于 NUL 二进制判定，否则 UTF-16 会被误判） */
function detectBOM(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return 'utf8bom'
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return 'utf16le'
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return 'utf16be'
  }
  return null
}

/** 检测是否为二进制内容 */
function isBinary(bytes: Uint8Array): boolean {
  for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

/** 检测是否为有效的 UTF-8 */
function isValidUTF8(bytes: Uint8Array): boolean {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    decoder.decode(bytes)
    return true
  } catch {
    return false
  }
}

/** 简单的 GB18030 检测（基于常见 GBK/GB18030 字节范围） */
function isLikelyGB18030(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b <= 0x7F) {
      i++
      continue
    }
    // GB18030 双字节: 0x81-0xFE 后跟 0x40-0xFE
    // GB18030 四字节: 0x81-0xFE 后跟 0x30-0x39 等
    if (b >= 0x81 && b <= 0xFE) {
      if (i + 1 < bytes.length) {
        const next = bytes[i + 1]
        if (next >= 0x40 && next <= 0xFE) {
          i += 2
          continue
        }
        if (next >= 0x30 && next <= 0x39) {
          // 可能是四字节编码
          if (i + 3 < bytes.length) {
            i += 4
            continue
          }
        }
      }
    }
    // 不符合 GB18030 模式
    return false
  }
  return true
}

self.onmessage = (event: MessageEvent<EncodingWorkerRequest>) => {
  const { id, bytesBase64 } = event.data

  try {
    const bytes = base64ToBytes(bytesBase64)

    // 1. 检测 BOM
    const bom = detectBOM(bytes)
    if (bom) {
      self.postMessage({
        id,
        success: true,
        encoding: bom,
      } as EncodingWorkerResponse)
      return
    }

    // 2. 检测二进制内容
    if (isBinary(bytes)) {
      self.postMessage({
        id,
        success: false,
        error: 'binary content',
      } as EncodingWorkerResponse)
      return
    }

    // 3. 检测 UTF-8
    if (isValidUTF8(bytes)) {
      self.postMessage({
        id,
        success: true,
        encoding: 'utf8',
      } as EncodingWorkerResponse)
      return
    }

    // 4. 检测 GB18030
    if (isLikelyGB18030(bytes)) {
      self.postMessage({
        id,
        success: true,
        encoding: 'gb18030',
      } as EncodingWorkerResponse)
      return
    }

    // 5. 未知编码
    self.postMessage({
      id,
      success: false,
      error: 'unsupported text encoding',
    } as EncodingWorkerResponse)
  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } as EncodingWorkerResponse)
  }
}

export {}