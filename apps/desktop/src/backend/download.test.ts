import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readProjectFile } from '../../../../packages/server/src/workspace/fs/projectFiles'
import { downloadFile } from './download'

let dir: string
let destination: string
const name = '远程 文件.png'
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qn-transfer-test-'))
  destination = join(dir, 'local.png')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

it.each([0, 620_123])('原样下载 %i 字节，含空文件和跨块二进制', async (size) => {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 251
  await writeFile(join(dir, name), bytes)
  await downloadFile(destination, (offset, length, version) =>
    readProjectFile({ root: dir, path: name, offset, length, version }))
  expect((await readFile(destination)).equals(bytes)).toBe(true)
})

it('远端文件在分块间变化时保留原目标并清理临时文件', async () => {
  await writeFile(join(dir, name), Buffer.alloc(300_000))
  await writeFile(destination, '保留旧文件')
  await expect(downloadFile(destination, async (offset, length, version) => {
    if (offset > 0) await writeFile(join(dir, name), '新内容')
    return readProjectFile({ root: dir, path: name, offset, length, version })
  })).rejects.toThrow()
  expect(await readFile(destination, 'utf8')).toBe('保留旧文件')
  expect((await readdir(dir)).sort()).toEqual([name, 'local.png'].sort())
})
