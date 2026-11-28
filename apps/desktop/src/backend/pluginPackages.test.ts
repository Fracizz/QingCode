import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { PluginPackages, unpackRgPlugin } from './pluginPackages'

it('独立打包、校验发版附件及纯离线导入往返', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qn-plugin-pack-'))
  try {
    const binary = join(root, 'rg')
    const license = join(root, 'LICENSE')
    await Promise.all([writeFile(binary, 'sample bytes'), writeFile(license, 'fixture license')])
    const output = execFileSync(process.execPath, [
      '--experimental-strip-types', 'scripts/package-rg-plugin.mjs',
      '--binary', binary, '--license', license, '--platform', 'linux-x64', '--version', '16.0.0',
      '--release', '0.0.3-beta.7', '--out', root,
    ], { encoding: 'utf8' }).trim().split(/\r?\n/)
    const [artifact, checksum] = output as [string, string]
    const archive = await readFile(artifact)
    const hash = createHash('sha256').update(archive).digest('hex')
    expect((await readFile(checksum, 'utf8')).trim().split(/\s+/)[0]).toBe(hash)
    const library = new PluginPackages(root)
    const info = await library.import(artifact)
    expect(info).toMatchObject({ platform: 'linux-x64', version: '16.0.0' })
    expect(await library.list()).toEqual([info])
    expect(await library.read('linux-x64')).toEqual({ info, binary: Buffer.from('sample bytes').toString('base64') })

    const tampered = JSON.parse(gunzipSync(archive).toString('utf8'))
    tampered.binary = Buffer.from('changed bytes').toString('base64')
    await expect(unpackRgPlugin(gzipSync(JSON.stringify(tampered)))).rejects.toThrow('SHA-256')
    await library.remove('linux-x64')
    expect(await library.list()).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
