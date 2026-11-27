import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { prepareNodeRuntime } from '../../apps/desktop/build/prepare-node-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'))
const desktopDir = path.resolve(here, '../../apps/desktop')
const outDir = path.join(desktopDir, 'resources/server')
const outFile = path.join(outDir, 'qn-server.cjs')

// 构建 ID 取产物内容哈希：先用占位符构建，再按内容哈希回填，同一份源码产物仍然可复现。
const BUILD_ID_PLACEHOLDER = 'QN_BUILD_ID_PLACEHOLDER'

await mkdir(outDir, { recursive: true })
await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: outFile,
  // 固定工作目录：pnpm 会在包目录下执行，注释里的相对路径不同会让产物 sha256 漂移。
  absWorkingDir: path.resolve(here, '../..'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // SDK 的 ESM 顶层用了 createRequire(import.meta.url)；CJS 产物没有 import.meta，
  // 用 define + banner 补一个等价的 file URL，否则 qn-server.cjs 一启动就抛错。
  define: { 'import.meta.url': '__qn_import_meta_url', __QN_BUILD_ID__: JSON.stringify(BUILD_ID_PLACEHOLDER) },
  banner: {
    js: `/* qingcode-next server v${pkg.version} (protocol 1) */
const __qn_import_meta_url = require('node:url').pathToFileURL(__filename).href;`,
  },
  // 原生 claude 二进制（每平台约 400MB）不打包；始终用目标机已安装的 claude。
  external: ['@anthropic-ai/claude-agent-sdk-*'],
  logLevel: 'warning',
})

const draft = await readFile(outFile, 'utf8')
if (!draft.includes(BUILD_ID_PLACEHOLDER)) throw new Error('qn-server.cjs 中缺少构建 ID 占位符')
const buildId = createHash('sha256').update(draft).digest('hex').slice(0, 12)
await writeFile(outFile, draft.replaceAll(BUILD_ID_PLACEHOLDER, buildId), 'utf8')

const bytes = await readFile(outFile)
const sha256 = createHash('sha256').update(bytes).digest('hex')
await writeFile(
  path.join(outDir, 'qn-server.json'),
  `${JSON.stringify({ version: pkg.version, sha256 }, null, 2)}\n`,
  'utf8',
)
console.log(`built ${outFile} v${pkg.version}+${buildId} (${bytes.byteLength} bytes, sha256 ${sha256.slice(0, 12)})`)

await prepareNodeRuntime(path.join(outDir, 'node-runtime'))

if (process.platform === 'win32') {
  const destination = path.join(outDir, 'conpty')
  await rm(destination, { recursive: true, force: true })
  const desktopRequire = createRequire(path.join(desktopDir, 'package.json'))
  let addonEntry
  try {
    const entry = desktopRequire.resolve('@lydell/node-pty')
    // 平台包是入口包的 optionalDependency，在 pnpm 下不能从桌面包直接解析。
    addonEntry = createRequire(entry).resolve('@lydell/node-pty-win32-x64')
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err
    console.warn('Windows ConPTY 资源缺失：需要 @lydell/node-pty 和对应的 win32-x64 预编译包')
  }
  if (addonEntry) {
    // Electron 的 extraResources 已将整个 server 目录复制到 ASAR 外。
    await cp(path.dirname(path.dirname(addonEntry)), destination, { recursive: true })
  }
}
