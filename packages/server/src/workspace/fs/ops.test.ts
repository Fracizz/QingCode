import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FsReadResult, FsStat } from '@qn/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import { findWorkspaceHandler } from '../index'
import { fsHandlers } from './index'
import { encodeText } from './encoding'
import { MAX_UTF8_READ_BYTES } from './logic'
import { cleanupAll, fakeCtx, tempDir } from './testUtils'

type Method = keyof typeof fsHandlers

function handler(method: Method) {
  const fn = fsHandlers[method]
  if (!fn) throw new Error(`未登记 ${method}`)
  return fn
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(err).toBeInstanceOf(WorkspaceError)
  return (err as WorkspaceError).code
}

afterEach(() => cleanupAll())

describe('处理函数登记', () => {
  it('所有 fs.* 方法都能经 workspace 分发找到', () => {
    const methods = [
      'fs.stat',
      'fs.read',
      'fs.write',
      'fs.mkdir',
      'fs.createFile',
      'fs.rename',
      'fs.delete',
      'fs.search',
      'fs.searchCancel',
      'fs.watch',
    ]
    for (const method of methods) expect(findWorkspaceHandler(method)).toBeTypeOf('function')
  })
})

describe('fs.stat / fs.read', () => {
  it('区分文件、目录与符号链接，缺失报 not_found', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'hello')
    const stat = (p: Record<string, unknown>) => handler('fs.stat')(p, fake.ctx) as Promise<FsStat>
    expect(await stat({ path: file })).toMatchObject({ path: file, kind: 'file', size: 5 })
    expect((await stat({ path: dir })).kind).toBe('dir')
    expect(await errorCodeOf(stat({ path: path.join(dir, 'missing') }))).toBe('not_found')
    try {
      const link = path.join(dir, 'link')
      fs.symlinkSync(file, link)
      expect((await stat({ path: link })).kind).toBe('symlink')
    } catch {
      // Windows 无符号链接权限时跳过该断言。
    }
  })

  it('默认返回完整 UTF-8 文本并给出 size/mtime', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'text.txt')
    const text = 'hello 世界\nsecond'
    fs.writeFileSync(file, text, 'utf8')
    const result = (await handler('fs.read')({ path: file }, fake.ctx)) as FsReadResult
    expect(result).toMatchObject({
      path: file,
      content: text,
      encoding: 'utf8',
      size: Buffer.byteLength(text),
      offset: 0,
      length: Buffer.byteLength(text),
      truncated: false,
      binary: false,
    })
    expect(result.mtimeMs).toBeGreaterThan(0)
  })

  it('按字节偏移读取并在多字节字符边界回退', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'multi.txt')
    fs.writeFileSync(file, 'a你b', 'utf8') // 61 e4 bd a0 62
    const read = (p: Record<string, unknown>) => handler('fs.read')(p, fake.ctx) as Promise<FsReadResult>
    expect(await read({ path: file, offset: 1, length: 3 })).toMatchObject({
      content: '你',
      length: 3,
      truncated: true,
    })
    expect(await read({ path: file, offset: 0, length: 3 })).toMatchObject({
      content: 'a',
      length: 1,
      truncated: true,
    })
    expect(await read({ path: file, offset: 4 })).toMatchObject({ content: 'b', length: 1, truncated: false })
  })

  it('自动判断二进制；显式 base64 时按二进制返回', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'bin.dat')
    const bytes = Buffer.from([0, 1, 2, 255])
    fs.writeFileSync(file, bytes)
    const read = (p: Record<string, unknown>) => handler('fs.read')(p, fake.ctx) as Promise<FsReadResult>
    expect(await read({ path: file })).toMatchObject({ binary: true, content: '', length: 0, encoding: 'utf8' })
    expect(await read({ path: file, encoding: 'base64' })).toMatchObject({
      binary: false,
      encoding: 'base64',
      content: bytes.toString('base64'),
      length: 4,
    })
    expect(await read({ path: file, encoding: 'utf8' })).toMatchObject({ binary: false })
  })

  it('默认读取上限 2 MiB，超出部分标记 truncated', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'big.bin')
    fs.writeFileSync(file, Buffer.alloc(MAX_UTF8_READ_BYTES + 16, 0x61))
    const result = (await handler('fs.read')({ path: file }, fake.ctx)) as FsReadResult
    expect(result.length).toBe(MAX_UTF8_READ_BYTES)
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(MAX_UTF8_READ_BYTES + 16)
  })

  it('参数不合法与文件不存在分别报 params / not_found', async () => {
    const fake = fakeCtx()
    const read = handler('fs.read')
    expect(await errorCodeOf(read({ path: 'relative/a' }, fake.ctx))).toBe('params')
    expect(await errorCodeOf(read({ path: '/tmp', offset: -1 }, fake.ctx))).toBe('params')
    expect(await errorCodeOf(read({ path: path.join(tempDir(), 'nope') }, fake.ctx))).toBe('not_found')
  })
})

describe('fs.write', () => {
  it('创建文件并返回新 mtime', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'new.txt')
    const result = (await handler('fs.write')({ path: file, content: '你好' }, fake.ctx)) as { mtimeMs: number }
    expect(fs.readFileSync(file, 'utf8')).toBe('你好')
    expect(result.mtimeMs).toBeGreaterThan(0)
  })

  it('expectedMtimeMs 差 >1ms 报 conflict 且不覆盖原内容', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'conflict.txt')
    fs.writeFileSync(file, 'original')
    const mtime = fs.statSync(file).mtimeMs
    const write = (p: Record<string, unknown>) => handler('fs.write')(p, fake.ctx)
    expect(await errorCodeOf(write({ path: file, content: 'x', expectedMtimeMs: mtime + 100 }))).toBe(
      'conflict',
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('original')
    await write({ path: file, content: 'ok', expectedMtimeMs: mtime })
    expect(fs.readFileSync(file, 'utf8')).toBe('ok')
  })

  it('create:false 时文件不存在报 not_found', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'missing.txt')
    expect(
      await errorCodeOf(handler('fs.write')({ path: file, content: 'x', create: false }, fake.ctx)),
    ).toBe('not_found')
  })

  it('base64 写入按字节落盘', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'base64.bin')
    const bytes = Buffer.from([0, 1, 2, 255])
    await handler('fs.write')({ path: file, content: bytes.toString('base64'), encoding: 'base64' }, fake.ctx)
    expect(fs.readFileSync(file)).toEqual(bytes)
  })

  it.skipIf(process.platform === 'win32')('覆盖写保留原文件权限位', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'mode.txt')
    fs.writeFileSync(file, 'a')
    fs.chmodSync(file, 0o640)
    await handler('fs.write')({ path: file, content: 'b' }, fake.ctx)
    expect(fs.statSync(file).mode & 0o7777).toBe(0o640)
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('.qn-'))).toEqual([])
  })
})

describe('fs.mkdir / createFile / rename / delete', () => {
  it('递归建目录、新建文件、重命名与删除', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const nested = path.join(dir, 'a', 'b')
    await handler('fs.mkdir')({ path: nested }, fake.ctx)
    expect(fs.statSync(nested).isDirectory()).toBe(true)

    const file = path.join(nested, 'x.txt')
    await handler('fs.createFile')({ path: file }, fake.ctx)
    expect(fs.existsSync(file)).toBe(true)
    expect(await errorCodeOf(handler('fs.createFile')({ path: file }, fake.ctx))).toBe('exists')

    const to = path.join(dir, 'y.txt')
    await handler('fs.rename')({ from: file, to }, fake.ctx)
    expect(fs.existsSync(to)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(await errorCodeOf(handler('fs.rename')({ from: to, to: dir }, fake.ctx))).toBe('exists')

    expect(await errorCodeOf(handler('fs.delete')({ path: dir }, fake.ctx))).toBe('not_empty')
    await handler('fs.delete')({ path: to }, fake.ctx)
    expect(fs.existsSync(to)).toBe(false)
    await handler('fs.delete')({ path: dir, recursive: true }, fake.ctx)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('拒绝删除根目录与用户主目录本身', async () => {
    const fake = fakeCtx()
    const remove = (p: Record<string, unknown>) => handler('fs.delete')(p, fake.ctx)
    expect(await errorCodeOf(remove({ path: path.parse(process.cwd()).root }))).toBe('params')
    expect(await errorCodeOf(remove({ path: os.homedir() }))).toBe('params')
    expect(await errorCodeOf(remove({ path: path.join(tempDir(), 'nope') }))).toBe('not_found')
  })

  it('非绝对路径报 params', async () => {
    const fake = fakeCtx()
    expect(await errorCodeOf(handler('fs.stat')({ path: 'rel' }, fake.ctx))).toBe('params')
    expect(await errorCodeOf(handler('fs.mkdir')({ path: '' }, fake.ctx))).toBe('params')
    expect(await errorCodeOf(handler('fs.delete')({ path: 'rel' }, fake.ctx))).toBe('params')
  })
})

describe('Windows 常见编码与换行', () => {
  const read = (fake: ReturnType<typeof fakeCtx>, file: string, extra: Record<string, unknown> = {}) =>
    handler('fs.read')({ path: file, ...extra }, fake.ctx) as Promise<FsReadResult>

  it('UTF-8 BOM 去掉并标 bom，CRLF 原样保留', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'bom-crlf.txt')
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('a\r\n中\r\n', 'utf8'),
    ])
    fs.writeFileSync(file, bytes)
    const result = await read(fake, file)
    expect(result).toMatchObject({
      content: 'a\r\n中\r\n',
      encoding: 'utf8',
      bom: true,
      binary: false,
      length: bytes.length,
      size: bytes.length,
      truncated: false,
    })
    expect((await read(fake, file, { encoding: 'base64' })).content).toBe(
      bytes.toString('base64'),
    )
  })

  it('fs.write 的 bom 写回 UTF-8 BOM 且不改换行', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'bom-write.txt')
    const text = 'a\r\n中\r\n'
    await handler('fs.write')({ path: file, content: text, bom: true }, fake.ctx)
    expect(fs.readFileSync(file).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect((await read(fake, file)).content).toBe(text)
    await handler('fs.write')({ path: file, content: text, bom: false }, fake.ctx)
    expect(fs.readFileSync(file).subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  for (const encoding of ['utf16le', 'utf16be'] as const) {
    it(`UTF-16 ${encoding}（含 CRLF 与代理对）解码为 utf8 并可无损写回`, async () => {
      const fake = fakeCtx()
      const file = path.join(tempDir(), `u16-${encoding}.txt`)
      const text = '第一行\r\n第二行 😀\r\n'
      const bytes = encodeText(text, encoding, true)
      fs.writeFileSync(file, bytes)
      const result = await read(fake, file)
      expect(result).toMatchObject({
        content: text,
        encoding: 'utf8',
        bom: true,
        sourceEncoding: encoding,
        binary: false,
        length: bytes.length,
        truncated: false,
      })
      await handler('fs.write')(
        {
          path: file,
          content: result.content,
          bom: result.bom,
          sourceEncoding: result.sourceEncoding,
        },
        fake.ctx,
      )
      expect(fs.readFileSync(file)).toEqual(bytes)
    })
  }

  it('UTF-16 偏移读对齐到码元边界', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'u16-offset.txt')
    const bytes = encodeText('abcdef', 'utf16le', true)
    fs.writeFileSync(file, bytes)
    const result = await read(fake, file, { offset: 3, length: 6 })
    expect(result).toMatchObject({ offset: 2, content: 'abc', length: 6, truncated: true })
  })

  it('UTF-8 BOM 之后是二进制内容时仍判为二进制', async () => {
    const fake = fakeCtx()
    const file = path.join(tempDir(), 'bom-binary.bin')
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0, 1, 2, 255])]),
    )
    expect((await read(fake, file)).binary).toBe(true)
  })

  it('不支持的 UTF-32 BOM 与无 BOM 的 UTF-16 按二进制处理', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const u32 = path.join(dir, 'u32.bin')
    fs.writeFileSync(u32, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]))
    expect((await read(fake, u32)).binary).toBe(true)
    const noBom = path.join(dir, 'u16-nobom.bin')
    fs.writeFileSync(noBom, Buffer.from([0x41, 0x00, 0x42, 0x00]))
    expect((await read(fake, noBom)).binary).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('盘符大小写与混用斜杠能读取同一文件', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const nested = path.join(dir, 'SubDir')
    fs.mkdirSync(nested)
    const file = path.join(nested, 'a.txt')
    fs.writeFileSync(file, 'x')
    const alt = path.join(dir.toUpperCase(), 'subdir', 'A.TXT').split(path.sep).join('/')
    expect((await handler('fs.stat')({ path: alt }, fake.ctx) as FsStat).kind).toBe('file')
    expect((await read(fake, alt)).content).toBe('x')
  })

  it.skipIf(process.platform !== 'win32')('\\\\?\\ 长路径前缀可读写', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const longDir = `\\\\?\\${path.resolve(
      path.join(dir, ...Array.from({ length: 10 }, (_, i) => `deep-${i}-${'x'.repeat(30)}`)),
    )}`
    fs.mkdirSync(longDir, { recursive: true })
    const file = path.join(longDir, 'long.txt')
    try {
      await handler('fs.write')({ path: file, content: 'hello' }, fake.ctx)
      expect((await read(fake, file)).content).toBe('hello')
    } finally {
      fs.rmSync(longDir, { recursive: true, force: true })
    }
  })
})
