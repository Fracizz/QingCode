import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

export async function prepareNodeRuntime(destination) {
  const version = 'v26.13.0'
  const file = `node-${version}-linux-x64`
  const sha256 = '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b'
  const assets = new URL('./node-runtime/', import.meta.url)
  await mkdir(destination, { recursive: true })
  const tmp = join(destination, `.${file}-${randomUUID()}`)
  try {
    const hash = createHash('sha256')
    const unzip = createGunzip()
    unzip.on('data', (chunk) => hash.update(chunk))
    await pipeline(createReadStream(new URL(`${file}.gz`, assets)), unzip, createWriteStream(tmp, { mode: 0o755 }))
    if (hash.digest('hex') !== sha256) throw new Error('内置 Linux x64 Node 校验失败')
    await rename(tmp, join(destination, file))
    await copyFile(new URL('LICENSE', assets), join(destination, 'LICENSE'))
    const manifest = { version, targets: { 'linux-x64': { file, sha256 } } }
    await writeFile(tmp, JSON.stringify(manifest, null, 2))
    await rename(tmp, join(destination, 'manifest.json'))
  } finally {
    await rm(tmp, { force: true })
  }
}
