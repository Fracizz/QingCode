import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'))
const outDir = path.resolve(here, '../../apps/desktop/resources/server')
const outFile = path.join(outDir, 'qn-server.cjs')

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
  define: { 'import.meta.url': '__qn_import_meta_url' },
  banner: {
    js: `/* qingcode-next server v${pkg.version} (protocol 1) */
const __qn_import_meta_url = require('node:url').pathToFileURL(__filename).href;`,
  },
  // 原生 claude 二进制（每平台约 400MB）不打包；始终用目标机已安装的 claude。
  external: ['@anthropic-ai/claude-agent-sdk-*'],
  logLevel: 'warning',
})

const bytes = await readFile(outFile)
const sha256 = createHash('sha256').update(bytes).digest('hex')
await writeFile(
  path.join(outDir, 'qn-server.json'),
  `${JSON.stringify({ version: pkg.version, sha256 }, null, 2)}\n`,
  'utf8',
)
console.log(`built ${outFile} (${bytes.byteLength} bytes, sha256 ${sha256.slice(0, 12)})`)
