import { describe, expect, it } from 'vitest'
import {
  alignUtf16Offset,
  decodeText,
  decodeUtf16,
  detectTextEncoding,
  encodeText,
} from './encoding'

const utf8 = { encoding: 'utf8' as const, bom: false, bomBytes: 0 }
const utf8Bom = { encoding: 'utf8' as const, bom: true, bomBytes: 3 }
const utf16le = { encoding: 'utf16le' as const, bom: true, bomBytes: 2 }
const utf16be = { encoding: 'utf16be' as const, bom: true, bomBytes: 2 }

describe('文本编码识别', () => {
  it('识别 UTF-8 BOM、UTF-16 LE/BE BOM 与无 BOM', () => {
    expect(detectTextEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual(utf8Bom)
    expect(detectTextEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual(utf16le)
    expect(detectTextEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toEqual(utf16be)
    expect(detectTextEncoding(Buffer.from('abc'))).toEqual(utf8)
    expect(detectTextEncoding(Buffer.alloc(0))).toEqual(utf8)
  })

  it('UTF-32 BOM 按不支持编码返回 null（调用方按二进制处理）', () => {
    expect(detectTextEncoding(Buffer.from([0xff, 0xfe, 0x00, 0x00]))).toBeNull()
    expect(detectTextEncoding(Buffer.from([0x00, 0x00, 0xfe, 0xff]))).toBeNull()
  })
})

describe('解码与编码', () => {
  it('UTF-8 BOM 去掉，CRLF 原样保留，length 含 BOM 的原始字节数', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('a\r\n中\r\n', 'utf8'),
    ])
    const decoded = decodeText(bytes, utf8Bom, true)
    expect(decoded).toEqual({ content: 'a\r\n中\r\n', length: bytes.length })
    expect(decoded.content).toContain('\r\n')
  })

  it('截断的多字节字符回退到完整边界', () => {
    const bytes = Buffer.from([0x61, 0xe4, 0xbd])
    expect(decodeText(bytes, utf8, false)).toEqual({ content: 'a', length: 1 })
  })

  it('UTF-16 LE/BE 解码为 utf8，写回字节完全一致（含代理对与 CRLF）', () => {
    const text = '第一行\r\n第二行 😀\r\n'
    for (const [info, encoding] of [
      [utf16le, 'utf16le' as const],
      [utf16be, 'utf16be' as const],
    ] as const) {
      const bytes = encodeText(text, encoding, true)
      const decoded = decodeText(bytes, info, true)
      expect(decoded.content).toBe(text)
      expect(decoded.length).toBe(bytes.length)
      expect(encodeText(decoded.content, encoding, true)).toEqual(bytes)
    }
    expect(encodeText('A', 'utf16le', true).subarray(0, 4)).toEqual(
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
    )
    expect(encodeText('A', 'utf16be', true).subarray(0, 4)).toEqual(
      Buffer.from([0xfe, 0xff, 0x00, 0x41]),
    )
  })

  it('UTF-8 BOM 写回可配置，不带 BOM 时不加前缀', () => {
    expect(encodeText('a', 'utf8', true)).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
    expect(encodeText('a', 'utf8', false)).toEqual(Buffer.from('a'))
  })

  it('UTF-16 末尾孤立高代理项回退 2 字节', () => {
    const bytes = Buffer.from([0x41, 0x00, 0x3d, 0xd8])
    expect(decodeUtf16(bytes, true)).toEqual({ content: 'A', length: 2 })
  })

  it('UTF-16 奇数偏移对齐到 BOM 之后的偶数边界', () => {
    expect(alignUtf16Offset(0, 2)).toBe(0)
    expect(alignUtf16Offset(1, 2)).toBe(0)
    expect(alignUtf16Offset(2, 2)).toBe(2)
    expect(alignUtf16Offset(3, 2)).toBe(2)
    expect(alignUtf16Offset(4, 2)).toBe(4)
    expect(alignUtf16Offset(5, 2)).toBe(4)
  })
})
