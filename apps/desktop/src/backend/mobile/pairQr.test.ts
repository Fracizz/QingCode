import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodePairQr } from './pairQr'

describe('配对二维码', () => {
  it.each([
    [120, 41, '6aa506305c3b4d9ce0b308d1e0f8cc18636f8b519d99b5bed0ec489f2ce2b95f'],
    [240, 57, 'e1079f72b9bacd0d3ba19aa40f7bba695137375e862f971e6d8783bac9862906'],
    [500, 77, 'f1e0b26500207ed39b85c8f7e30dd842c6fe4be50f33e5766feaa6bb8558f2f2'],
  ])('生成 %i 字节的标准 QR 模块矩阵', (length, size, hash) => {
    // 哈希从独立 QR 编码器取得，覆盖长链接的版本信息和不等长纠错块。
    const rows = encodePairQr('x'.repeat(length))
    expect(rows).toHaveLength(size)
    expect(rows.every((row) => row.length === size && /^[01]*$/.test(row))).toBe(true)
    expect(createHash('sha256').update(rows.join('')).digest('hex')).toBe(hash)
  })

  it('长度超出支持范围时提示复制导入', () => {
    expect(() => encodePairQr('x'.repeat(1000))).toThrow(/复制导入/)
  })
})
