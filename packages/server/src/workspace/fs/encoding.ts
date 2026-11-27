import { utf8SafeLength } from './logic'

// Windows 上常见 UTF-8 BOM、UTF-16 LE/BE BOM 文本文件；协议只传 utf8 内容，
// 源编码与 BOM 作为元数据回传，客户端写回时原样带回即可无损保存。

export type SourceEncoding = 'utf8' | 'utf16le' | 'utf16be'

export interface TextEncoding {
  encoding: SourceEncoding
  bom: boolean
  bomBytes: number
}

export interface DecodedText {
  content: string
  /** 实际消费的原始字节数（含 BOM），末尾不完整字符/代理项不计入 */
  length: number
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

/** 返回 null 表示遇到不支持的编码（如 UTF-32 BOM），调用方按二进制处理。 */
export function detectTextEncoding(head: Uint8Array): TextEncoding | null {
  const b0 = head[0]
  const b1 = head[1]
  const b2 = head[2]
  const b3 = head[3]
  // UTF-32 LE/BE 的 BOM 与 UTF-16 LE 的前两字节重合，先排除。
  if (b0 === 0xff && b1 === 0xfe && b2 === 0x00 && b3 === 0x00) return null
  if (b0 === 0x00 && b1 === 0x00 && b2 === 0xfe && b3 === 0xff) return null
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    return { encoding: 'utf8', bom: true, bomBytes: 3 }
  }
  if (b0 === 0xff && b1 === 0xfe) {
    return { encoding: 'utf16le', bom: true, bomBytes: 2 }
  }
  if (b0 === 0xfe && b1 === 0xff) {
    return { encoding: 'utf16be', bom: true, bomBytes: 2 }
  }
  return { encoding: 'utf8', bom: false, bomBytes: 0 }
}

function swapUtf16(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1]!
    out[i + 1] = buf[i]!
  }
  return out
}

/** Node 只有 utf16le 解码器，BE 先按双字节交换；末尾孤立高代理项回退 2 字节。 */
export function decodeUtf16(data: Uint8Array, littleEndian: boolean): DecodedText {
  let buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (!littleEndian) buf = swapUtf16(buf)
  let length = buf.length - (buf.length % 2)
  if (length >= 2) {
    const last = buf.readUInt16LE(length - 2)
    if (last >= 0xd800 && last <= 0xdbff) length -= 2
  }
  return { content: buf.subarray(0, length).toString('utf16le'), length }
}

/** content 去掉 BOM 并解码为 utf8；length 为原始字节数，供 offset 续读使用。 */
export function decodeText(
  data: Uint8Array,
  info: TextEncoding,
  hasBomAtStart: boolean,
): DecodedText {
  const skip = hasBomAtStart ? info.bomBytes : 0
  const body = data.subarray(skip)
  if (info.encoding === 'utf8') {
    const safe = utf8SafeLength(body)
    return {
      content: Buffer.from(body.subarray(0, safe)).toString('utf8'),
      length: skip + safe,
    }
  }
  const decoded = decodeUtf16(body, info.encoding === 'utf16le')
  return { content: decoded.content, length: skip + decoded.length }
}

export function encodeText(content: string, encoding: SourceEncoding, bom: boolean): Buffer {
  if (encoding === 'utf8') {
    const body = Buffer.from(content, 'utf8')
    return bom ? Buffer.concat([UTF8_BOM, body]) : body
  }
  const body = Buffer.from(content, 'utf16le')
  const bytes = encoding === 'utf16be' ? swapUtf16(body) : body
  return bom
    ? Buffer.concat([encoding === 'utf16be' ? UTF16BE_BOM : UTF16LE_BOM, bytes])
    : bytes
}

/** UTF-16 按双字节码元寻址，奇数偏移回退到 BOM 之后的偶数边界。 */
export function alignUtf16Offset(offset: number, bomBytes: number): number {
  if (offset < bomBytes) return 0
  const relative = offset - bomBytes
  return bomBytes + relative - (relative % 2)
}
