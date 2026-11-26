import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BridgeRpcError } from './errors'
import {
  attachmentNote,
  base64DecodedLength,
  buildTurnContent,
  imageBlockToEcho,
  imageMediaTypeFromPath,
  loadLocalImage,
  MAX_IMAGE_BYTES,
  parseDataUrl,
  parseTurnInput,
  resolveTurnInput,
} from './userInput'

function rpcCode(fn: () => unknown): number | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof BridgeRpcError ? err.code : -1
  }
  return undefined
}

async function rpcCodeAsync(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn()
  } catch (err) {
    return err instanceof BridgeRpcError ? err.code : -1
  }
  return undefined
}

describe('data URL 与 media_type', () => {
  it('解析 base64 data URL，media_type 小写，空白被去除', () => {
    expect(parseDataUrl('data:IMAGE/PNG;base64,QU\nJD')).toEqual({ mediaType: 'image/png', data: 'QUJD' })
    expect(parseDataUrl('data:image/png;charset=x;base64,QUJD')?.data).toBe('QUJD')
    expect(parseDataUrl('data:image/png,abc')).toBeNull()
    expect(parseDataUrl('http://x/a.png')).toBeNull()
  })

  it('按扩展名判断 media_type，未知返回 null', () => {
    expect(imageMediaTypeFromPath('/a/B.JPG')).toBe('image/jpeg')
    expect(imageMediaTypeFromPath('/a/b.webp')).toBe('image/webp')
    expect(imageMediaTypeFromPath('/a/b.bmp')).toBeNull()
    expect(imageMediaTypeFromPath('/a/b')).toBeNull()
  })

  it('估算 base64 解码长度', () => {
    expect(base64DecodedLength('')).toBe(0)
    expect(base64DecodedLength('QUJD')).toBe(3)
    expect(base64DecodedLength('QQ==')).toBe(1)
    expect(base64DecodedLength('QUI=')).toBe(2)
  })
})

describe('parseTurnInput', () => {
  it('分类各类输入，skill 去掉前导斜杠', () => {
    const parsed = parseTurnInput([
      { type: 'text', text: 'hi', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'image', url: 'https://x.test/a.png' },
      { type: 'localImage', path: '/tmp/a.png' },
      { type: 'mention', name: 'f', path: '/tmp/f.txt' },
      { type: 'skill', name: '/review', path: '/s' },
      { type: 'audio', url: 'x' },
    ])
    expect(parsed.texts).toEqual(['hi'])
    expect(parsed.skills).toEqual(['review'])
    expect(parsed.images).toEqual([
      { kind: 'base64', mediaType: 'image/png', data: 'QUJD' },
      { kind: 'url', url: 'https://x.test/a.png' },
      { kind: 'file', path: '/tmp/a.png' },
    ])
    expect(parsed.mentions).toEqual([{ name: 'f', path: '/tmp/f.txt' }])
  })

  it('不支持的类型、过大、格式错误都是 -32602', () => {
    expect(rpcCode(() => parseTurnInput([{ type: 'image', url: 'data:image/bmp;base64,QUJD' }]))).toBe(-32602)
    expect(rpcCode(() => parseTurnInput([{ type: 'image', url: 'data:image/png,xx' }]))).toBe(-32602)
    expect(rpcCode(() => parseTurnInput([{ type: 'image', url: 'ftp://x/a.png' }]))).toBe(-32602)
    const big = 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 10) * 4) / 3))
    expect(rpcCode(() => parseTurnInput([{ type: 'image', url: `data:image/png;base64,${big}` }]))).toBe(-32602)
  })

  it('非数组输入得到空结果', () => {
    expect(parseTurnInput(null)).toEqual({ texts: [], skills: [], images: [], mentions: [] })
  })
})

describe('buildTurnContent', () => {
  it('图片在前文本在后；skill 前缀在最前；mention 追加说明；回显同序', () => {
    const parsed = parseTurnInput([
      { type: 'text', text: '问题' },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'image', url: 'https://x.test/a.png' },
      { type: 'localImage', path: '/tmp/a.jpg' },
      { type: 'skill', name: 'review', path: '/s' },
      { type: 'mention', name: 'a.txt', path: '/w/a.txt' },
    ])
    const content = buildTurnContent(parsed, [{ mediaType: 'image/jpeg', data: 'REVG' }])
    expect(content.blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
      { type: 'text', text: `/review 问题\n\n${attachmentNote(parsed.mentions)}` },
    ])
    expect(content.echo.map((e) => e.type)).toEqual(['image', 'image', 'image', 'text'])
    expect(content.echo[2]).toEqual({ type: 'image', url: 'data:image/jpeg;base64,REVG' })
    expect(content.text).toContain('附件文件（请按需读取）：\n- a.txt: /w/a.txt')
  })

  it('只有图片不产生文本块；只有 mention 文本不带前导空行', () => {
    const onlyImage = buildTurnContent(parseTurnInput([{ type: 'image', url: 'data:image/gif;base64,QUJD' }]))
    expect(onlyImage.blocks).toHaveLength(1)
    const onlyMention = buildTurnContent(parseTurnInput([{ type: 'mention', name: 'n', path: '/p' }]))
    expect(onlyMention.text).toBe('附件文件（请按需读取）：\n- n: /p')
  })
})

describe('imageBlockToEcho', () => {
  it('base64 / url / 非法块', () => {
    expect(imageBlockToEcho({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } })).toEqual({
      type: 'image',
      url: 'data:image/png;base64,QQ==',
    })
    expect(imageBlockToEcho({ type: 'image', source: { type: 'url', url: 'https://a/b.png' } })).toEqual({
      type: 'image',
      url: 'https://a/b.png',
    })
    expect(imageBlockToEcho({ type: 'image', source: { type: 'file' } })).toBeNull()
    expect(imageBlockToEcho({ type: 'text' })).toBeNull()
  })
})

describe('localImage IO', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qn-userinput-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('读取图片并转 base64', async () => {
    const path = join(dir, 'a.png')
    await writeFile(path, Buffer.from('ABC'))
    expect(await loadLocalImage(path)).toEqual({ mediaType: 'image/png', data: 'QUJD' })
  })

  it('读不到、类型不支持、过大都是 -32602', async () => {
    expect(await rpcCodeAsync(() => loadLocalImage(join(dir, 'missing.png')))).toBe(-32602)
    const txt = join(dir, 'a.txt')
    await writeFile(txt, 'x')
    expect(await rpcCodeAsync(() => loadLocalImage(txt))).toBe(-32602)
    expect(
      await rpcCodeAsync(() =>
        loadLocalImage('/fake/big.png', {
          size: async () => MAX_IMAGE_BYTES + 1,
          read: async () => Buffer.alloc(0),
        }),
      ),
    ).toBe(-32602)
  })

  it('resolveTurnInput：localImage 进入内容块；空输入报错', async () => {
    const path = join(dir, 'b.webp')
    await writeFile(path, Buffer.from('ABC'))
    const content = await resolveTurnInput([{ type: 'localImage', path }])
    expect(content.blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'QUJD' } },
    ])
    expect(await rpcCodeAsync(() => resolveTurnInput([{ type: 'text', text: '' }]))).toBe(-32602)
  })
})
