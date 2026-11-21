// QingCode 的 pi 预热加载器：在专用空目录先加载 pi 入口的全部静态依赖，
// 领取时从 stdin 读一行 base64 目标目录，切换后再运行 pi 的原始入口。
// pi 没有会话内切换目录的命令，模块加载是预热唯一能提前完成的部分。
// 本文件会嵌入 PowerShell here-string 与 sh heredoc：不得出现以 '@ 开头的行或 QC_PI_PRELOAD 行。
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import module from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

try {
  unlinkSync(fileURLToPath(import.meta.url))
} catch {
  // 临时文件删不掉不影响运行，启动脚本退出时会再清理。
}
const { QC_PI_BIN: bin, QC_PI_NONCE: nonce, QC_PI_RETURN: returnFile } = process.env
delete process.env.QC_PI_BIN
delete process.env.QC_PI_NONCE
delete process.env.QC_PI_RETURN
const mark = phase => process.stdout.write(`QC-${nonce}-${phase}!`)
// 无法定位 pi 的 Node 入口（例如 bun 编译版或 pnpm shim）时，由启动脚本在目标目录普通启动 pi。
const UNSUPPORTED = 75
const PACKAGES = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']

/** 返回 pi 的实际入口（打包版为 cli-runtime.js）与对应的 bin 脚本路径。 */
function locate(command) {
  let real
  try {
    real = realpathSync(command)
  } catch {
    return undefined
  }
  const candidates = []
  if (real.endsWith('.js')) candidates.push([join(dirname(real), 'cli-runtime.js'), real], [real, real])
  for (const name of PACKAGES) {
    const root = join(dirname(real), 'node_modules', name, 'dist')
    candidates.push([join(root, 'bundle', 'cli-runtime.js'), join(root, 'bundle', 'cli.js')], [join(root, 'cli.js'), join(root, 'cli.js')])
  }
  const found = candidates.find(([entry]) => existsSync(entry))
  return found && { entry: found[0], script: found[1] }
}

/** 按入口里的顺序导入相对依赖，求值顺序与直接运行入口一致。 */
async function preload(entry) {
  const base = pathToFileURL(entry)
  for (const [, spec] of readFileSync(entry, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*["'](\.\.?\/[^"']+)["']/g)) {
    await import(new URL(spec, base).href)
  }
}

/** 以 readable 模式读取一行；多读的字节放回流中，结束后流恢复为初始状态交给 pi 的 TUI。 */
function readLine() {
  const stdin = process.stdin
  return new Promise((resolve, reject) => {
    const chunks = []
    const finish = (error, line) => {
      stdin.off('readable', onReadable)
      stdin.off('end', onEnd)
      if (error) reject(error)
      else resolve(line)
    }
    const onEnd = () => finish(new Error('stdin closed'))
    function onReadable() {
      let chunk
      while ((chunk = stdin.read()) !== null) {
        chunks.push(chunk)
        const buffer = Buffer.concat(chunks)
        const end = buffer.findIndex(byte => byte === 10 || byte === 13)
        if (end < 0) continue
        let rest = end
        while (rest < buffer.length && (buffer[rest] === 10 || buffer[rest] === 13)) rest += 1
        if (rest < buffer.length) stdin.unshift(buffer.subarray(rest))
        finish(undefined, buffer.subarray(0, end).toString('utf8'))
        return
      }
    }
    stdin.on('readable', onReadable)
    stdin.on('end', onEnd)
  })
}

module.enableCompileCache?.()
const target = bin ? locate(bin) : undefined
if (target) {
  try {
    await preload(target.entry)
  } catch {
    // 预加载失败时仍可运行入口，由入口自己报告错误。
  }
}
mark('ready')
let directory
try {
  directory = Buffer.from((await readLine()).trim(), 'base64').toString('utf8')
  process.chdir(directory)
  if (returnFile) writeFileSync(returnFile, directory)
} catch {
  mark('error')
  process.exit(1)
}
mark('cwd')
if (!target) process.exit(UNSUPPORTED)
process.argv.splice(1, process.argv.length - 1, target.script)
await import(pathToFileURL(target.entry).href)
