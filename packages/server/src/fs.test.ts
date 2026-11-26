import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fsHome, fsList } from './fs'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qn-fs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('fsHome / fsList', () => {
  it('fs.home 返回用户目录', () => {
    expect(fsHome().path).toBe(os.homedir())
  })

  it('按名称排序并区分目录与文件', async () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'b-dir'))
    fs.mkdirSync(path.join(dir, 'a-dir'))
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x')
    const result = await fsList({ path: dir })
    expect(result.path).toBe(dir)
    expect(result.entries).toEqual([
      { name: 'a-dir', kind: 'dir' },
      { name: 'b-dir', kind: 'dir' },
      { name: 'c.txt', kind: 'file' },
    ])
  })

  it('dirsOnly 过滤普通文件', async () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'file'), 'x')
    expect((await fsList({ path: dir, dirsOnly: true })).entries).toEqual([
      { name: 'sub', kind: 'dir' },
    ])
  })

  it('最多返回 2000 条', async () => {
    const dir = tempDir()
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}`), '')
    const entries = (await fsList({ path: dir })).entries
    expect(entries).toHaveLength(2000)
    expect(entries[0]?.name).toBe('f0000')
    expect(entries[1999]?.name).toBe('f1999')
  })

  it('目录不存在时抛错', async () => {
    await expect(fsList({ path: path.join(os.tmpdir(), 'qn-not-exists-xyz') })).rejects.toThrow()
  })
})
