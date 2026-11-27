import { RouterError } from '../router'

// QR 的字节模式与 L 纠错参数，按能容纳配对链接的版本升序排列。
const versions = [
  { version: 6, centers: [6, 34], ecc: 18, groups: [[2, 68]] },
  { version: 7, centers: [6, 22, 38], ecc: 20, groups: [[2, 78]] },
  { version: 8, centers: [6, 24, 42], ecc: 24, groups: [[2, 97]] },
  { version: 9, centers: [6, 26, 46], ecc: 30, groups: [[2, 116]] },
  { version: 10, centers: [6, 28, 50], ecc: 18, groups: [[2, 68], [2, 69]] },
  { version: 11, centers: [6, 30, 54], ecc: 20, groups: [[4, 81]] },
  { version: 12, centers: [6, 32, 58], ecc: 24, groups: [[2, 92], [2, 93]] },
  { version: 13, centers: [6, 34, 62], ecc: 26, groups: [[4, 107]] },
  { version: 14, centers: [6, 26, 46, 66], ecc: 30, groups: [[3, 115], [1, 116]] },
  { version: 15, centers: [6, 26, 48, 70], ecc: 22, groups: [[5, 87], [1, 88]] },
  { version: 16, centers: [6, 26, 50, 74], ecc: 24, groups: [[5, 98], [1, 99]] },
  { version: 17, centers: [6, 30, 54, 78], ecc: 28, groups: [[1, 107], [5, 108]] },
] as const

type QrVersion = (typeof versions)[number]
const capacity = (config: QrVersion) => config.groups.reduce((total, [count, length]) => total + count * length, 0)

function multiply(a: number, b: number): number {
  let value = 0
  for (let bit = 7; bit >= 0; bit--) {
    value = (value << 1) ^ ((value >>> 7) * 0x11d)
    value ^= a * ((b >>> bit) & 1)
  }
  return value
}

function correction(block: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of block) {
    const leading = byte ^ result.shift()!
    result.push(0)
    for (let i = 0; i < result.length; i++) result[i] = result[i]! ^ multiply(divisor[i]!, leading)
  }
  return result
}

function codewords(bytes: Uint8Array, config: QrVersion): number[] {
  const available = capacity(config)
  const bits: number[] = []
  const put = (value: number, width: number) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1)
  }
  put(4, 4)
  put(bytes.length, config.version < 10 ? 8 : 16)
  for (const byte of bytes) put(byte, 8)
  put(0, Math.min(4, 8 * available - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let at = 0; at < bits.length; at += 8) {
    data.push(bits.slice(at, at + 8).reduce((value, bit) => (value << 1) | bit, 0))
  }
  for (let pad = 0; data.length < available; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11)

  const divisor = new Array<number>(config.ecc).fill(0)
  divisor[divisor.length - 1] = 1
  let root = 1
  for (let exponent = 0; exponent < config.ecc; exponent++) {
    for (let index = 0; index < divisor.length; index++) {
      divisor[index] = multiply(divisor[index]!, root) ^ (divisor[index + 1] ?? 0)
    }
    root = multiply(root, 2)
  }
  const blocks: number[][] = []
  let offset = 0
  for (const [count, length] of config.groups) {
    for (let block = 0; block < count; block++) {
      blocks.push(data.slice(offset, offset + length))
      offset += length
    }
  }
  const parity = blocks.map((block) => correction(block, divisor))
  const interleaved: number[] = []
  for (const group of [blocks, parity]) {
    for (let i = 0; i < Math.max(...group.map((block) => block.length)); i++) {
      for (const block of group) {
        const byte = block[i]
        if (byte !== undefined) interleaved.push(byte)
      }
    }
  }
  return interleaved
}

export function encodePairQr(link: string): string[] {
  const bytes = new TextEncoder().encode(link)
  const config = versions.find((candidate) => bytes.length + (candidate.version < 10 ? 2 : 3) <= capacity(candidate))
  if (!config) throw new RouterError('invalid_params', '连接信息太长，请使用复制导入')
  const size = 17 + config.version * 4
  const modules = Array.from({ length: size }, () => new Int8Array(size).fill(-1))
  const mark = (x: number, y: number, dark: boolean) => {
    const row = modules[y]
    if (row && x >= 0 && x < size) row[x] = Number(dark)
  }

  for (let at = 0; at < size; at++) {
    mark(at, 6, at % 2 === 0)
    mark(6, at, at % 2 === 0)
  }
  for (const [x, y] of [[3, 3], [3, size - 4], [size - 4, 3]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        mark(x + dx, y + dy, distance !== 2 && distance !== 4)
      }
    }
  }
  for (const x of config.centers) {
    for (const y of config.centers) {
      if ((x === 6 || y === 6) && (x === y || x === size - 7 || y === size - 7)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) mark(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }
  if (config.version >= 7) {
    let remainder: number = config.version
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const version = (config.version << 12) | remainder
    for (let i = 0; i < 18; i++) {
      const x = size - 11 + i % 3
      const y = Math.floor(i / 3)
      const dark = Boolean((version >>> i) & 1)
      mark(x, y, dark)
      mark(y, x, dark)
    }
  }

  // 固定使用掩膜 0；格式字由 L 纠错级和掩膜编号确定。
  const format = (bit: number) => Boolean((0x77c4 >>> bit) & 1)
  for (let i = 0; i <= 5; i++) mark(8, i, format(i))
  mark(8, 7, format(6))
  mark(8, 8, format(7))
  mark(7, 8, format(8))
  for (let i = 9; i < 15; i++) mark(14 - i, 8, format(i))
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8, format(i))
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i, format(i))
  mark(8, size - 8, true)

  const data = codewords(bytes, config)
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let offset = 0; offset < size; offset++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - offset : offset
      for (let side = 0; side < 2; side++) {
        const x = right - side
        if (modules[y]?.[x] !== -1) continue
        const value = ((data[index >>> 3] ?? 0) >>> (7 - index % 8)) & 1
        mark(x, y, Boolean(value ^ Number((x + y) % 2 === 0)))
        index += 1
      }
    }
  }
  return modules.map((row) => row.join(''))
}
