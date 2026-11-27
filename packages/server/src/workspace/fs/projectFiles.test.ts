import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProjectFiles, readProjectFile, searchProjectFiles } from './projectFiles'

const temp: string[] = []
afterEach(async () => {
  await Promise.all(temp.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qn-project-files-'))
  temp.push(directory)
  const root = join(directory, 'workspace')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, '.codex'))
  await writeFile(join(root, '.codex', 'auth.json'), 'test fixture')
  await writeFile(join(root, 'src', 'Demo.ts'), 'abcdef')
  await writeFile(join(directory, 'outside'), 'unrelated')
  return { root, directory }
}

describe('项目只读文件', () => {
  it('按相对路径列出和搜索，并用版本校验分段下载', async () => {
    const { root } = await fixture()
    expect((await listProjectFiles({ root })).entries.map((entry) => entry.path)).toEqual(['src'])
    expect((await searchProjectFiles({ root, query: 'demo' })).entries.map((entry) => entry.path)).toEqual(['src/Demo.ts'])
    expect((await listProjectFiles({ root, path: '.codex', hidden: true })).entries).toEqual([])
    await expect(readProjectFile({ root, path: '.codex/auth.json' })).rejects.toMatchObject({ code: 'permission' })
    const first = await readProjectFile({ root, path: 'src/Demo.ts', length: 3 })
    expect(first).toMatchObject({ content: 'YWJj', length: 3, size: 6 })
    const second = await readProjectFile({ root, path: 'src/Demo.ts', offset: 3, version: first.version })
    expect(second).toMatchObject({ content: 'ZGVm', length: 3, version: first.version })
    await writeFile(join(root, 'src', 'Demo.ts'), 'changed')
    await expect(readProjectFile({ root, path: 'src/Demo.ts', offset: 3, version: first.version }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('拒绝绝对路径、父目录和符号链接', async () => {
    const { root, directory } = await fixture()
    await expect(readProjectFile({ root, path: '../outside' })).rejects.toMatchObject({ code: 'params' })
    await expect(readProjectFile({ root, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'params' })
    await symlink(directory, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readProjectFile({ root, path: 'external/outside' })).rejects.toMatchObject({ code: 'permission' })
    expect((await listProjectFiles({ root })).entries.map((entry) => entry.path)).not.toContain('external')
  })

  it.runIf(process.platform === 'win32')('接受旧版 SFTP 形式的 Windows 项目根', async () => {
    const { root } = await fixture()
    const sftpRoot = `/${root.replace(/\\/g, '/')}`
    expect((await listProjectFiles({ root: sftpRoot })).entries.map((entry) => entry.path)).toEqual(['src'])
    expect((await readProjectFile({ root: sftpRoot, path: 'src/Demo.ts' })).content).toBe('YWJjZGVm')
  })
})
