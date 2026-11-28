import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { isRgPluginPlatform, isRgPluginVersion, MAX_RG_BINARY_BYTES } from '../packages/protocol/src/plugins.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function main() {
  const { values } = parseArgs({ options: {
    version: { type: 'string' },
    platform: { type: 'string' },
    binary: { type: 'string' },
    license: { type: 'string', multiple: true },
    release: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('node --experimental-strip-types scripts/package-rg-plugin.mjs --version X.Y.Z --platform linux-x64 --binary /path/to/rg --license /path/to/LICENSE [--release X.Y.Z-beta.N] [--out /path/to/output]')
    return
  }
  const { version, platform, binary, license, release, out } = values
  if (!isRgPluginVersion(version) || !isRgPluginPlatform(platform) || !binary || !license?.length ||
      (release !== undefined && !/^\d{1,8}\.\d{1,8}\.\d{1,8}(?:-beta\.\d{1,16})?$/.test(release))) {
    throw new Error('参数无效，请用 --help 查看用法')
  }
  const source = await stat(binary)
  if (!source.isFile() || source.size === 0 || source.size > MAX_RG_BINARY_BYTES) throw new Error('rg 二进制大小无效')
  const bytes = await readFile(binary)
  if (!bytes.length || bytes.length > MAX_RG_BINARY_BYTES) throw new Error('rg 二进制大小无效')
  const licenses = (await Promise.all(license.map((path) => readFile(path, 'utf8')))).join('\n\n')
  if (!licenses.trim() || Buffer.byteLength(licenses) > 128 * 1024) throw new Error('许可证内容无效')

  const archive = gzipSync(JSON.stringify({
    format: 1,
    tool: 'rg',
    info: { platform, version, sha256: sha256(bytes) },
    binary: bytes.toString('base64'),
    license: licenses,
  }), { level: 9 })
  if (archive.length > 9 * 1024 * 1024) throw new Error('插件包超出大小上限')
  const directory = out ? resolve(out) : join(root, 'release', 'plugins', release ?? '')
  const name = `QingCode-Next-plugin-rg-${version}-${platform}.qnplugin`
  await mkdir(directory, { recursive: true })
  const checksumPath = join(directory, `${name}.sha256`)
  const archivePath = join(directory, name)
  // 同一版本的附件保持不可变，重复执行可补齐尚未写出的校验文件。
  const stage = await mkdtemp(join(directory, '.rg-package-'))
  try {
    await writeArtifact(join(stage, name), archivePath, archive)
    await writeArtifact(join(stage, `${name}.sha256`), checksumPath, Buffer.from(`${sha256(archive)}  ${name}\n`, 'utf8'))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  console.log(archivePath)
  console.log(checksumPath)
}

async function writeArtifact(staged, path, bytes) {
  await writeFile(staged, bytes, { flag: 'wx' })
  try {
    await link(staged, path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await readFile(path)).equals(bytes)) throw new Error(`同名发布文件已存在且内容不同：${path}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
