import fs from 'node:fs'
import path from 'node:path'
import type { FsSearchMatch, FsSearchResultEvt } from '@qn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import { fsHandlers } from './index'
import { resetRgProbe, startSearch } from './search'
import { cleanupAll, fakeCtx, tempDir, waitFor, type FakeCtx } from './testUtils'

function searchEvents(fake: FakeCtx, searchId: string): FsSearchResultEvt[] {
  return fake.events
    .filter((event) => event.name === 'fs.searchResult')
    .map((event) => event.payload as FsSearchResultEvt)
    .filter((event) => event.searchId === searchId)
}

function matchesOf(fake: FakeCtx, searchId: string): FsSearchMatch[] {
  return searchEvents(fake, searchId).flatMap((event) => event.matches)
}

function doneOf(fake: FakeCtx, searchId: string): FsSearchResultEvt | undefined {
  return searchEvents(fake, searchId).find((event) => event.done)
}

async function runFallback(
  fake: FakeCtx,
  params: Record<string, unknown>,
): Promise<string> {
  const { searchId } = startSearch(params, fake.ctx, { rgAvailable: false })
  await waitFor(() => doneOf(fake, searchId) !== undefined)
  return searchId
}

beforeEach(() => resetRgProbe())
afterEach(() => cleanupAll())

describe('fs.search（Node 兜底遍历）', () => {
  it('name 模式大小写不敏感并跳过版本控制/依赖目录', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.mkdirSync(path.join(dir, '.git'))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    fs.writeFileSync(path.join(dir, 'src', 'HelloWorld.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'src', 'plain.txt'), 'x')
    fs.writeFileSync(path.join(dir, '.git', 'hit-hello.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'node_modules', 'hit-hello.ts'), 'x')

    const id = await runFallback(fake, { root: dir, query: 'HELLO', mode: 'name' })
    expect(matchesOf(fake, id).map((match) => match.path)).toEqual([
      path.join(dir, 'src', 'HelloWorld.ts'),
    ])
    expect(doneOf(fake, id)?.truncated).toBeFalsy()

    const sensitive = await runFallback(fake, {
      root: dir,
      query: 'hello',
      mode: 'name',
      caseSensitive: true,
    })
    expect(matchesOf(fake, sensitive)).toHaveLength(0)
  })

  it('content 模式给出行列与文本，跳过二进制和大文件', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'first\nHello World\nlast\n')
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    fs.mkdirSync(path.join(dir, '.svn'))
    fs.writeFileSync(path.join(dir, '.svn', 'skip.txt'), 'Hello')
    const id = await runFallback(fake, { root: dir, query: 'hello', mode: 'content' })
    const matches = matchesOf(fake, id)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      path: path.join(dir, 'a.txt'),
      line: 2,
      column: 1,
      text: 'Hello World',
    })
  })

  it('glob 只放行匹配的文件', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'hit-a.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'hit-b.md'), 'x')
    fs.writeFileSync(path.join(dir, 'src', 'hit-c.ts'), 'x')
    const id = await runFallback(fake, { root: dir, query: 'hit', mode: 'name', glob: '*.ts' })
    expect(new Set(matchesOf(fake, id).map((match) => match.path))).toEqual(
      new Set([path.join(dir, 'hit-a.ts'), path.join(dir, 'src', 'hit-c.ts')]),
    )
  })

  it('达到 maxResults 立即停止并标记 truncated', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `hit-${i}.txt`), 'x')
    const id = await runFallback(fake, { root: dir, query: 'hit', mode: 'name', maxResults: 3 })
    expect(matchesOf(fake, id)).toHaveLength(3)
    expect(doneOf(fake, id)?.truncated).toBe(true)
  })

  it('结果分批推送且每批不超过 200 条', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(dir, `hit-${i}.txt`), 'x')
    const id = await runFallback(fake, { root: dir, query: 'hit', mode: 'name' })
    expect(matchesOf(fake, id)).toHaveLength(250)
    expect(searchEvents(fake, id).filter((event) => !event.done).every((event) => event.matches.length <= 200)).toBe(
      true,
    )
    expect(doneOf(fake, id)?.truncated).toBeFalsy()
  })

  it('root 不存在时通过 done 事件给出 error', async () => {
    const fake = fakeCtx()
    const id = await runFallback(fake, {
      root: path.join(tempDir(), 'nope'),
      query: 'x',
      mode: 'name',
    })
    expect(doneOf(fake, id)?.error).toContain('无法访问 root')
  })

  it.skipIf(process.platform !== 'win32')('跳过 Windows 系统目录并按文件名大小写不敏感搜索', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    for (const name of ['$RECYCLE.BIN', 'System Volume Information']) {
      fs.mkdirSync(path.join(dir, name))
      fs.writeFileSync(path.join(dir, name, 'hit-HELLO.ts'), 'x')
    }
    fs.writeFileSync(path.join(dir, 'HIT-Hello.TXT'), 'x')
    const id = await runFallback(fake, { root: dir, query: 'hello', mode: 'name' })
    expect(matchesOf(fake, id).map((match) => path.basename(match.path))).toEqual([
      'HIT-Hello.TXT',
    ])
  })

  it('Node 遍历遵守简化的 .gitignore（含取反与嵌套文件）', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      'dist/\r\n*.log\r\n!hit-keep.log\r\nsrc/generated/**\r\n',
    )
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'dist', 'hit.ts'), 'x')
    fs.mkdirSync(path.join(dir, 'src', 'generated'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', '.gitignore'), 'hit-secret.ts\n')
    fs.writeFileSync(path.join(dir, 'src', 'generated', 'hit.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'src', 'hit.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'src', 'hit-secret.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'hit-secret.ts'), 'x')
    fs.writeFileSync(path.join(dir, 'hit-a.log'), 'x')
    fs.writeFileSync(path.join(dir, 'hit-keep.log'), 'x')
    const id = await runFallback(fake, { root: dir, query: 'HIT', mode: 'name' })
    const names = matchesOf(fake, id).map((match) => path.basename(match.path)).sort()
    expect(names).toEqual(['hit-keep.log', 'hit-secret.ts', 'hit.ts'].sort())
    expect(doneOf(fake, id)?.error).toBeUndefined()
  })

  it('大小写不同的重复路径不会重复推送', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'hit.ts'), 'x')
    const id = await runFallback(fake, { root: dir, query: 'hit', mode: 'name' })
    expect(matchesOf(fake, id)).toHaveLength(1)
  })
})

describe('fs.search 的 rg 路径与取消', () => {
  it('优先 rg 时仍能按内容搜到结果（缺 rg 自动退化为 Node 遍历）', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'needle here\n')
    const { searchId } = startSearch(
      { root: dir, query: 'needle', mode: 'content' },
      fake.ctx,
      { rgAvailable: true },
    )
    await waitFor(() => doneOf(fake, searchId) !== undefined, 5000)
    expect(doneOf(fake, searchId)?.error).toBeUndefined()
    expect(matchesOf(fake, searchId).some((match) => match.text?.includes('needle'))).toBe(true)
  })

  it('fs.search 处理函数立即返回 searchId 并流式推送', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'only match\n')
    const result = (await fsHandlers['fs.search']!(
      { root: dir, query: 'only', mode: 'content' },
      fake.ctx,
    )) as { searchId: string }
    expect(result.searchId).toBeTruthy()
    expect(fake.cleanupCount).toBeGreaterThan(0)
    await waitFor(() => doneOf(fake, result.searchId) !== undefined, 5000)
    expect(matchesOf(fake, result.searchId).length).toBeGreaterThan(0)
  })

  it('searchCancel 收尾并停止后续遍历', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `hit-${i}.txt`), 'x')
    const { searchId } = startSearch(
      { root: dir, query: 'hit', mode: 'name', maxResults: 5000 },
      fake.ctx,
      { rgAvailable: false },
    )
    await fsHandlers['fs.searchCancel']!({ searchId }, fake.ctx)
    expect(doneOf(fake, searchId)?.done).toBe(true)
    const snapshot = searchEvents(fake, searchId).length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(searchEvents(fake, searchId)).toHaveLength(snapshot)
  })

  it('未知 searchId 的取消是幂等的', async () => {
    const fake = fakeCtx()
    expect(await fsHandlers['fs.searchCancel']!({ searchId: 'nope' }, fake.ctx)).toEqual({})
  })

  it('参数不合法时抛出 WorkspaceError(params)', async () => {
    const fake = fakeCtx()
    const err = await fsHandlers['fs.search']!({ root: 'rel', query: 'x', mode: 'name' }, fake.ctx).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(err).toBeInstanceOf(WorkspaceError)
    expect((err as WorkspaceError).code).toBe('params')
  })
})
