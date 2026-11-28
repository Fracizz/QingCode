import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { FsSearchResultEvt } from '@qn/protocol'
import { RgPlugin } from './rgPlugin'
import { startSearch } from './workspace/fs/search'
import { fakeCtx, waitFor } from './workspace/fs/testUtils'

function fixture(version: string, hit: string, platform = `${process.platform}-${process.arch}`) {
  const bytes = Buffer.from(`#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'ripgrep ${version}\\n'; else printf '${hit}\\n'; fi\n`)
  return {
    bytes,
    info: { platform, version, sha256: createHash('sha256').update(bytes).digest('hex') },
    binary: bytes.toString('base64'),
  }
}

it.skipIf(process.platform === 'win32')('PATH 优先，托管版成功后热切换，移除后回落 Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qn-plugin-target-'))
  const bin = join(root, 'bin')
  const project = join(root, 'project')
  try {
    await Promise.all([mkdir(bin), mkdir(project)])
    await writeFile(join(project, 'node-hit.ts'), 'test')
    vi.stubEnv('PATH', bin)
    const plugin = new RgPlugin(root)
    const search = async () => {
      const ctx = fakeCtx()
      ctx.ctx.resolveRg = () => plugin.executables()
      startSearch({ root: project, query: 'hit', mode: 'name' }, ctx.ctx)
      const events = () => ctx.events.map((event) => event.payload as FsSearchResultEvt)
      await waitFor(() => events().some((event) => event.done))
      return events().flatMap((event) => event.matches.flatMap((match) => match.path))
    }
    expect(await search()).toEqual([join(project, 'node-hit.ts')])
    const first = fixture('16.0.0', 'managed-hit.ts')
    await expect(plugin.install(first.info, first.binary)).resolves.toMatchObject({ source: 'managed', installed: first.info })
    expect(await search()).toEqual([join(project, 'managed-hit.ts')])
    const invalidVersion = fixture('16.0.1', 'invalid-hit.ts')
    await expect(plugin.install({ ...invalidVersion.info, version: '16.0.2' }, invalidVersion.binary)).rejects.toThrow('版本自检')
    await expect(plugin.install({ ...first.info, platform: 'win32-x64' }, first.binary)).rejects.toThrow('平台')
    await expect(plugin.install(first.info, invalidVersion.binary)).rejects.toThrow('SHA-256')
    expect(await search()).toEqual([join(project, 'managed-hit.ts')])

    const system = fixture('15.0.0', 'system-hit.ts')
    await writeFile(join(bin, 'rg'), system.bytes, { mode: 0o700 })
    expect(await plugin.status(true)).toMatchObject({ source: 'system', version: '15.0.0', installed: first.info })
    expect(await search()).toEqual([join(project, 'system-hit.ts')])
    await expect(plugin.remove()).resolves.toEqual({ platform: first.info.platform, source: 'system', version: '15.0.0' })
    await rm(join(bin, 'rg'))
    await expect(plugin.status(true)).resolves.toMatchObject({ source: 'missing' })
    expect(await search()).toEqual([join(project, 'node-hit.ts')])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
