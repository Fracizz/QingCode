import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES } from './index'

function makeFrame(payload: string | Uint8Array, declaredLength?: number): Uint8Array {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  const frame = new Uint8Array(4 + bytes.byteLength)
  new DataView(frame.buffer).setUint32(0, declaredLength ?? bytes.byteLength, false)
  frame.set(bytes, 4)
  return frame
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

describe('encodeFrame', () => {
  it('往返还原对象、数组、中文与基本类型', () => {
    const values: unknown[] = [
      { t: 'hello', text: '你好，世界 🌍' },
      [1, '二', null, { deep: true }],
      '中文内容',
      '',
      0,
      null,
      false,
    ]
    const decoder = new FrameDecoder()
    for (const value of values) {
      const frame = encodeFrame(value)
      expect(new DataView(frame.buffer).getUint32(0, false)).toBe(frame.byteLength - 4)
      expect(frame.subarray(4)).toEqual(new TextEncoder().encode(JSON.stringify(value)))
      expect(decoder.push(frame)).toEqual([value])
    }
  })

  it('长度前缀使用大端 uint32', () => {
    const frame = encodeFrame({ x: '中' })
    const length = frame.byteLength - 4
    expect(Array.from(frame.subarray(0, 4))).toEqual([
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ])
    expect(length).toBe(11)
  })

  it('负载超过上限抛 oversize', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES)
    expect(() => encodeFrame(huge)).toThrowError(FrameError)
    try {
      encodeFrame(huge)
    } catch (error) {
      expect((error as FrameError).code).toBe('oversize')
    }
  })

  it('不可序列化的值抛 json 错误', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const value of [undefined, () => 1, Symbol('x'), 1n, circular]) {
      try {
        encodeFrame(value)
        throw new Error('expected FrameError')
      } catch (error) {
        expect(error).toBeInstanceOf(FrameError)
        expect((error as FrameError).code).toBe('json')
      }
    }
  })
})

describe('FrameDecoder', () => {
  it('一次推入多帧（粘包）', () => {
    const frames = [encodeFrame({ n: 1 }), encodeFrame('中文'), encodeFrame([1, 2, 3])]
    expect(new FrameDecoder().push(concat(frames))).toEqual([{ n: 1 }, '中文', [1, 2, 3]])
  })

  it('逐字节切分', () => {
    const all = concat([encodeFrame({ t: 'req', id: 1 }), encodeFrame('世界'), encodeFrame(42)])
    const decoder = new FrameDecoder()
    const received: unknown[] = []
    for (const byte of all) received.push(...decoder.push(Uint8Array.of(byte)))
    expect(received).toEqual([{ t: 'req', id: 1 }, '世界', 42])
  })

  it('任意切分（头部与负载都可能跨块）', () => {
    const frames = [encodeFrame({ a: '你' }), encodeFrame({ b: [1, 2, 3] }), encodeFrame(null)]
    const all = concat(frames)
    const decoder = new FrameDecoder()
    const received: unknown[] = []
    const sizes = [1, 2, 3, 5, 8, 13, 1, 21]
    let offset = 0
    let i = 0
    while (offset < all.byteLength) {
      const size = Math.min(sizes[i % sizes.length] as number, all.byteLength - offset)
      received.push(...decoder.push(all.subarray(offset, offset + size)))
      offset += size
      i++
    }
    expect(received).toEqual([{ a: '你' }, { b: [1, 2, 3] }, null])
  })

  it('空块与不完整帧都返回空数组', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(new Uint8Array(0))).toEqual([])
    const frame = encodeFrame({ text: '中文' })
    expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.push(frame.subarray(2, 6))).toEqual([])
    expect(decoder.push(frame.subarray(6))).toEqual([{ text: '中文' }])
  })

  it('头部声明长度超限立即抛 oversize，且不缓存巨量负载', () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
    const decoder = new FrameDecoder()
    try {
      decoder.push(header)
      throw new Error('expected FrameError')
    } catch (error) {
      expect(error).toBeInstanceOf(FrameError)
      expect((error as FrameError).code).toBe('oversize')
    }
  })

  it('非法 JSON / 非法 UTF-8 / 空负载抛 json 错误', () => {
    for (const frame of [
      makeFrame('{not json'),
      makeFrame(Uint8Array.of(0xff, 0xfe)),
      makeFrame(''),
      makeFrame('{"a":'),
    ]) {
      try {
        new FrameDecoder().push(frame)
        throw new Error('expected FrameError')
      } catch (error) {
        expect(error).toBeInstanceOf(FrameError)
        expect((error as FrameError).code).toBe('json')
      }
    }
  })

  it('连续两帧中文内容按帧边界切分', () => {
    const all = concat([makeFrame('"第一"'), makeFrame('"第二"')])
    expect(new FrameDecoder().push(all)).toEqual(['第一', '第二'])
  })

  it('声明长度未满足时跨块继续等待', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(makeFrame('12', 3))).toEqual([])
    expect(decoder.push(new TextEncoder().encode('3'))).toEqual([123])
  })

  it('协议错误后清空缓冲，新帧仍可解码', () => {
    const decoder = new FrameDecoder()
    expect(() => decoder.push(makeFrame('{bad'))).toThrowError(FrameError)
    expect(decoder.push(encodeFrame({ ok: true }))).toEqual([{ ok: true }])
  })

  it('FrameError 带 code 且是 Error 实例', () => {
    const error = new FrameError('oversize', 'too big')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('FrameError')
    expect(error.code).toBe('oversize')
    expect(error.message).toBe('too big')
  })
})
