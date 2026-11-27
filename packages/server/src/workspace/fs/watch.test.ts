import fs from 'node:fs'
import path from 'node:path'
import type { FsChangedEvt } from '@qn/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import { fsHandlers } from './index'
import { cleanupAll, fakeCtx, tempDir, waitFor, type FakeCtx } from './testUtils'

function watch(p: Record<string, unknown>, ctx: FakeCtx['ctx']): Promise<unknown> {
  return fsHandlers['fs.watch']!(p, ctx)
}

function changedEvents(fake: FakeCtx): FsChangedEvt[] {
  return fake.events
    .filter((event) => event.name === 'fs.changed')
    .map((event) => event.payload as FsChangedEvt)
}

afterEach(() => cleanupAll())

describe('fs.watch', () => {
  it('监听目录变化，去抖后推送绝对路径', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    await watch({ paths: [dir] }, fake.ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y')
    expect(await waitFor(() => changedEvents(fake).length > 0, 3000)).toBe(true)
    const paths = changedEvents(fake).flatMap((event) => event.paths)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((item) => path.isAbsolute(item))).toBe(true)
    expect(paths.some((item) => item === path.join(dir, 'b.txt') || item === dir)).toBe(true)
  })

  it('再次调用全量替换，空数组即取消全部监听', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    await watch({ paths: [dir] }, fake.ctx)
    await watch({ paths: [] }, fake.ctx)
    const before = changedEvents(fake).length
    fs.writeFileSync(path.join(dir, 'c.txt'), 'z')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(changedEvents(fake)).toHaveLength(before)
  })

  it('连接断开时清理所有 watcher', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    await watch({ paths: [dir] }, fake.ctx)
    expect(fake.cleanupCount).toBeGreaterThan(0)
    fake.close()
    const before = changedEvents(fake).length
    fs.writeFileSync(path.join(dir, 'd.txt'), 'w')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(changedEvents(fake)).toHaveLength(before)
  })

  it('超过 500 个路径时截断并记日志', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const paths = Array.from({ length: 501 }, (_, i) => path.join(dir, `p${i}`))
    expect(await watch({ paths }, fake.ctx)).toEqual({})
    expect(fake.logs.some((line) => line.includes('超过上限'))).toBe(true)
  })

  it.skipIf(!['win32', 'darwin'].includes(process.platform))(
    'Windows/macOS 递归监听项目根，子目录变化也能收到',
    async () => {
      const fake = fakeCtx()
      const dir = tempDir()
      const nested = path.join(dir, 'nested')
      fs.mkdirSync(nested)
      await watch({ paths: [dir] }, fake.ctx)
      fs.writeFileSync(path.join(nested, 'deep.txt'), 'x')
      expect(
        await waitFor(
          () =>
            changedEvents(fake)
              .flatMap((event) => event.paths)
              .some((item) => item.toLowerCase().endsWith('deep.txt')),
          4000,
        ),
      ).toBe(true)
    },
  )

  it('大小写不同的同一目录不会重复推送变化路径', async () => {
    const fake = fakeCtx()
    const dir = tempDir()
    const alt = process.platform === 'win32' ? dir.toUpperCase() : dir
    await watch({ paths: [dir, alt] }, fake.ctx)
    fs.writeFileSync(path.join(dir, 'same.txt'), 'x')
    expect(await waitFor(() => changedEvents(fake).length > 0, 3000)).toBe(true)
    const paths = changedEvents(fake).flatMap((event) => event.paths)
    const keys = new Set(
      paths.map((item) => (process.platform === 'win32' ? item.toLowerCase() : item)),
    )
    expect(keys.size).toBe(paths.length)
  })

  it('非绝对路径报 params', async () => {
    const fake = fakeCtx()
    const err = await watch({ paths: ['relative'] }, fake.ctx).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(err).toBeInstanceOf(WorkspaceError)
    expect((err as WorkspaceError).code).toBe('params')
  })
})
