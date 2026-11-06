import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const fontPath = resolve(root, 'mobile/android/web/qingcode-symbols.woff2')
const targetPoints = [0x23f4, 0x23f5, 0x23f6, 0x23f7, 0x23f8, 0x23f9, 0x23fa, 0x25a0, 0x25b6, 0x2713, 0x2717, 0x2b06]

function readWoff2Tables(font: Buffer) {
  expect(font.toString('ascii', 0, 4)).toBe('wOF2')
  expect(font.readUInt32BE(8)).toBe(font.length)
  const knownTags = 'cmap head hhea hmtx maxp name OS/2 post cvt fpgm glyf loca prep CFF VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill'.split(' ').map(tag => tag.padEnd(4, ' '))
  let cursor = 48
  function readBase128() {
    let value = 0
    for (let index = 0; index < 5; index += 1) {
      const byte = font.readUInt8(cursor++)
      if ((index === 0 && byte === 0x80) || value > 0x1ffffff) throw new Error('Invalid WOFF2 UIntBase128')
      value = value * 128 + (byte & 0x7f)
      if (!(byte & 0x80)) return value
    }
    throw new Error('Invalid WOFF2 UIntBase128 length')
  }
  const directory = Array.from({ length: font.readUInt16BE(12) }, () => {
    const flags = font.readUInt8(cursor++)
    const tagIndex = flags & 0x3f
    let tag = knownTags[tagIndex]
    if (tagIndex === 63) {
      tag = font.toString('ascii', cursor, cursor + 4)
      cursor += 4
    }
    const originalLength = readBase128()
    const version = flags >> 6
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0
    return { tag, length: transformed ? readBase128() : originalLength, transformed }
  })
  const data = brotliDecompressSync(font.subarray(cursor, cursor + font.readUInt32BE(20)))
  expect(directory.reduce((total, table) => total + table.length, 0)).toBe(data.length)
  let offset = 0
  return new Map(directory.map(table => {
    const entry = { data: data.subarray(offset, offset + table.length), transformed: table.transformed }
    offset += table.length
    return [table.tag, entry] as const
  }))
}

function readCmapGlyphId(cmap: Buffer, point: number) {
  for (let index = 0; index < cmap.readUInt16BE(2); index += 1) {
    const record = 4 + index * 8
    const platform = cmap.readUInt16BE(record)
    if (platform !== 0 && !(platform === 3 && cmap.readUInt16BE(record + 2) === 1)) continue
    const offset = cmap.readUInt32BE(record + 4)
    if (cmap.readUInt16BE(offset) !== 4) continue
    const segments = cmap.readUInt16BE(offset + 6) / 2
    for (let segment = 0; segment < segments; segment += 1) {
      const end = cmap.readUInt16BE(offset + 14 + segment * 2)
      const start = cmap.readUInt16BE(offset + 16 + segments * 2 + segment * 2)
      if (point < start || point > end) continue
      const delta = cmap.readInt16BE(offset + 16 + segments * 4 + segment * 2)
      const rangeAddress = offset + 16 + segments * 6 + segment * 2
      const rangeOffset = cmap.readUInt16BE(rangeAddress)
      if (!rangeOffset) return (point + delta) & 0xffff
      const glyph = cmap.readUInt16BE(rangeAddress + rangeOffset + (point - start) * 2)
      return glyph ? (glyph + delta) & 0xffff : 0
    }
  }
  return 0
}

it('contains real outlined glyphs for the Android terminal status symbols, not just a WOFF2 header', () => {
  const tables = readWoff2Tables(readFileSync(fontPath))
  const cmap = tables.get('cmap')!
  expect(cmap.transformed).toBe(false)
  const glyf = tables.get('glyf')!
  expect(glyf.transformed).toBe(true)
  expect(glyf.data.readUInt16BE(0)).toBe(0)
  const glyphCount = glyf.data.readUInt16BE(4)
  expect(glyphCount).toBe(tables.get('maxp')!.data.readUInt16BE(4))
  expect(glyf.data.readUInt32BE(8)).toBe(glyphCount * 2)
  for (const point of targetPoints) {
    const label = `U+${point.toString(16).toUpperCase()}`
    const glyphId = readCmapGlyphId(cmap.data, point)
    expect(glyphId, `${label} must not map to .notdef`).toBeGreaterThan(0)
    expect(glyphId, label).toBeLessThan(glyphCount)
    expect(glyf.data.readInt16BE(36 + glyphId * 2), `${label} must have an outline`).not.toBe(0)
  }
  for (const point of [0x20, 0x41, 0x4d, 0x57, 0x69, 0x4e2d]) {
    expect(readCmapGlyphId(cmap.data, point), 'The subset must not replace regular monospace text').toBe(0)
  }
})

it('prioritizes the bundled symbol subset without changing the monospace text family', () => {
  const css = readFileSync(resolve(root, 'mobile/android/web/app.css'), 'utf8')
  const face = /@font-face\s*\{([^}]+)\}/.exec(css)?.[1]
  expect(face).toContain("font-family: 'QingCode Symbols'")
  expect(face).toContain("url('qingcode-symbols.woff2') format('woff2')")
  expect(face).toContain('font-display: swap')
  const ranges = /unicode-range:\s*([^;]+)/.exec(face!)![1].split(',').map(range => {
    const [start, end = start] = range.trim().replace(/^U\+/i, '').split('-')
    return [Number.parseInt(start, 16), Number.parseInt(end, 16)]
  })
  for (const point of targetPoints) expect(ranges.some(([start, end]) => point >= start && point <= end)).toBe(true)
  for (const point of [0x20, 0x41, 0x4d, 0x4e2d]) expect(ranges.some(([start, end]) => point >= start && point <= end)).toBe(false)
  expect(css).toMatch(/--mono:\s*'QingCode Symbols',\s*ui-monospace,[^;]*monospace;/)
})
