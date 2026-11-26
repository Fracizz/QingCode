import { describe, expect, it } from 'vitest'
import { attachmentBytes, insertFileMention, isDraftImage, mentionAt, nearBottom } from './composerLogic'

describe('移动端输入', () => {
  it('定位光标处的 @，保留其余草稿并插入带空格的路径', () => {
    expect(mentionAt('看 alice@example.com', 20)).toBeNull()
    const draft = '看看 @src/a.ts 的实现'
    const range = mentionAt(draft, 9)
    expect(range).toEqual({ start: 3, end: 12, query: 'src/a' })
    expect(insertFileMention(draft, range!, 'src/my test.ts').text).toBe('看看 `src/my test.ts`  的实现')
  })

  it('校验图片类型并按实际字节数预留网关请求空间', () => {
    const image = { name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AQ==' }
    expect(isDraftImage(image)).toBe(true)
    expect(attachmentBytes([image])).toBe(1)
    expect(isDraftImage({ ...image, dataUrl: 'data:image/svg+xml;base64,AQ==' })).toBe(false)
  })

  it('在回看历史时保持滚动位置', () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 460 })).toBe(true)
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false)
  })
})
