import { describe, expect, it } from 'vitest'
import {
  base64Bytes,
  IMAGE_MAX_BYTES,
  imageDataUrlProblem,
  imageSendBlock,
  imageSupportFor,
  MAX_IMAGES,
  turnInputSizeProblem,
  modalityTable,
  parseImageDataUrl,
  screenFiles,
} from './images'

const file = (name: string, type: string, size = 100) => ({ name, type, size })

describe('screenFiles', () => {
  it('非图片文件原样放行，支持的图片计数', () => {
    const files = [file('a.png', 'image/png'), file('notes.txt', 'text/plain'), file('b.JPG', '')]
    const result = screenFiles(files, { existingImages: 0, imagesAllowed: true })
    expect(result.accepted.map((f) => f.name)).toEqual(['a.png', 'notes.txt', 'b.JPG'])
    expect(result.rejected).toEqual([])
  })

  it('bmp / svg 等按普通文件处理（与聊天区附件流程口径一致）', () => {
    const result = screenFiles([file('a.bmp', 'image/bmp')], { existingImages: 0, imagesAllowed: true })
    expect(result.accepted).toHaveLength(1)
  })

  it('超过 10 MiB 的图片被拒并给出原因', () => {
    const result = screenFiles([file('big.png', 'image/png', IMAGE_MAX_BYTES + 1)], {
      existingImages: 0,
      imagesAllowed: true,
    })
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toMatch(/超过 10 MiB/)
  })

  it('最多 50 张：已有图片计入，超出部分被拒', () => {
    const files = [file('1.png', 'image/png'), file('2.png', 'image/png'), file('c.txt', 'text/plain')]
    const result = screenFiles(files, { existingImages: MAX_IMAGES - 1, imagesAllowed: true })
    expect(result.accepted.map((f) => f.name)).toEqual(['1.png', 'c.txt'])
    expect(result.rejected).toEqual([{ name: '2.png', reason: `一条消息最多 ${MAX_IMAGES} 张图片` }])
  })

  it('模型不支持图片时拒绝图片但放行文件，原因透传', () => {
    const result = screenFiles([file('', 'image/png'), file('a.md', 'text/markdown')], {
      existingImages: 0,
      imagesAllowed: false,
      unsupportedReason: '当前模型 X 不支持图片输入',
    })
    expect(result.accepted.map((f) => f.name)).toEqual(['a.md'])
    expect(result.rejected).toEqual([{ name: '粘贴的图片', reason: '当前模型 X 不支持图片输入' }])
  })
})

describe('data URL', () => {
  it('解析 base64 data URL，mime 小写、去掉空白、估算字节', () => {
    expect(parseImageDataUrl('data:Image/PNG;base64,QU JD\nRA==')).toEqual({
      mimeType: 'image/png',
      data: 'QUJDRA==',
      bytes: 4,
    })
    expect(parseImageDataUrl('data:image/png,raw')).toBeNull()
    expect(parseImageDataUrl('https://x/a.png')).toBeNull()
  })

  it('base64 字节估算处理填充', () => {
    expect(base64Bytes('')).toBe(0)
    expect(base64Bytes('QUJD')).toBe(3)
    expect(base64Bytes('QUI=')).toBe(2)
    expect(base64Bytes('QQ==')).toBe(1)
  })

  it('单张校验：类型与大小', () => {
    expect(imageDataUrlProblem('data:image/webp;base64,QUJD')).toBeNull()
    expect(imageDataUrlProblem('data:image/bmp;base64,QUJD')).toMatch(/不支持的图片类型/)
    expect(imageDataUrlProblem('not a url')).toBe('图片数据无效')
    const big = 'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 3) / 3) * 4)
    expect(imageDataUrlProblem(`data:image/png;base64,${big}`)).toMatch(/超过/)
  })
})

describe('imageSendBlock', () => {
  const ok = 'data:image/png;base64,QUJD'
  it('没有图片不阻止', () => {
    expect(imageSendBlock([], false)).toBeNull()
  })
  it('模型不支持图片时阻止并提示移除', () => {
    expect(imageSendBlock([ok], false, '当前模型不支持图片输入')).toBe('当前模型不支持图片输入，请移除图片后再发送')
  })
  it('张数与单张问题', () => {
    expect(imageSendBlock(Array(MAX_IMAGES).fill(ok), true)).toBeNull()
    expect(imageSendBlock(Array(MAX_IMAGES + 1).fill(ok), true)).toMatch(/最多 50 张/)
    expect(imageSendBlock([ok, 'data:image/tiff;base64,QUJD'], true)).toMatch(/请移除后再发送/)
  })

  it('按编码后合计体积拦截多张大图，单张仍可发送', () => {
    const image = `data:image/png;base64,${'QUJD'.repeat(2_400_000)}`
    expect(imageSendBlock([image], true)).toBeNull()
    expect(imageSendBlock([image, image], true)).toContain('超过传输上限')
  })

  it('正文与附件按同一帧计算，包含多字节字符', () => {
    const image = { type: 'image' as const, url: `data:image/png;base64,${'QUJD'.repeat(3_000_000)}` }
    const text = { type: 'text' as const, text: '字'.repeat(1_600_000), text_elements: [] }
    expect(turnInputSizeProblem([image])).toBeNull()
    expect(turnInputSizeProblem([text])).toBeNull()
    expect(turnInputSizeProblem([image, text])).toContain('超过传输上限')
  })
})

describe('模型输入模态', () => {
  const raw = [
    { id: 'a', model: 'gpt-x', inputModalities: ['text', 'image'], isDefault: true },
    { id: 'b', model: 'text-only', inputModalities: ['text'] },
    { id: 'c', model: 'undeclared' },
    { id: 'd', model: 'empty', inputModalities: [] },
    null,
    { model: '' },
  ]
  const table = modalityTable(raw)

  it('提取 inputModalities 与默认模型；缺字段记为 null', () => {
    expect(table.defaultModel).toBe('gpt-x')
    expect(table.models).toEqual({
      'gpt-x': ['text', 'image'],
      'text-only': ['text'],
      undeclared: null,
      empty: [],
    })
  })

  it('只有明确声明且不含 image 才禁用', () => {
    expect(imageSupportFor(table, 'gpt-x').allowed).toBe(true)
    expect(imageSupportFor(table, 'text-only', 'Text Only')).toEqual({
      allowed: false,
      reason: '当前模型 Text Only 不支持图片输入',
    })
    expect(imageSupportFor(table, 'undeclared').allowed).toBe(true)
    expect(imageSupportFor(table, 'empty').allowed).toBe(true)
    expect(imageSupportFor(table, 'missing').allowed).toBe(true)
    expect(imageSupportFor(null, 'text-only').allowed).toBe(true)
  })

  it('未选模型时按默认模型判断', () => {
    expect(imageSupportFor(modalityTable([{ model: 'm', inputModalities: ['text'], isDefault: true }]), null).allowed).toBe(false)
  })
})
