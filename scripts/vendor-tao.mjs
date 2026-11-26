#!/usr/bin/env node
// 重新 vendor tao 并重放 QingCode 补丁（src-tauri/vendor/tao-patches/*.patch）。
// 升级 Tauri 时用：tauri-runtime-wry 要求的 tao 版本变了，就用本脚本生成新的 vendor/tao。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = path.join(root, 'src-tauri/vendor')
const patchesDir = path.join(vendorDir, 'tao-patches')
const help = `重新 vendor tao 并应用 QingCode 补丁：
  node scripts/vendor-tao.mjs --version <x.y.z> [--skip 0001] [--out <dir>] [--check]
  --version  crates.io 上的 tao 版本（必填）
  --skip     跳过文件名以该前缀开头的补丁，可重复
  --out      输出目录，默认 src-tauri/vendor/tao（会整体替换，保留 QINGCODE.md）
  --check    只验证下载与补丁能否应用，不写入输出目录`

export function parseArgs(argv) {
  const opts = { version: null, skip: [], out: path.join(vendorDir, 'tao'), check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') opts.version = argv[++i]
    else if (a === '--skip') opts.skip.push(argv[++i])
    else if (a === '--out') opts.out = path.resolve(argv[++i])
    else if (a === '--check') opts.check = true
    else if (a === '-h' || a === '--help') opts.help = true
    else throw new Error(`未知参数: ${a}`)
  }
  if (!opts.help && !/^\d+\.\d+\.\d+$/.test(opts.version ?? '')) throw new Error('--version 需为 x.y.z')
  return opts
}

export function selectPatches(files, skip) {
  return files
    .filter((f) => f.endsWith('.patch'))
    .sort()
    .filter((f) => !skip.some((s) => f.startsWith(s)))
}

async function fetchCrate(version) {
  const ua = { 'User-Agent': 'qingcode-vendor-tao' }
  const meta = await fetch(`https://crates.io/api/v1/crates/tao/${version}`, { headers: ua })
  if (!meta.ok) throw new Error(`crates.io 查询 tao ${version} 失败: HTTP ${meta.status}`)
  const { version: info } = await meta.json()
  if (info.yanked) throw new Error(`tao ${version} 已被 yank`)
  const res = await fetch(`https://static.crates.io/crates/tao/tao-${version}.crate`, { headers: ua })
  if (!res.ok) throw new Error(`下载 tao ${version} 失败: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = createHash('sha256').update(buf).digest('hex')
  if (sha !== info.checksum) throw new Error(`校验和不符: ${sha} != ${info.checksum}`)
  return { buf, sha }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) return console.log(help)

  const patches = selectPatches(readdirSync(patchesDir), opts.skip)
  const { buf, sha } = await fetchCrate(opts.version)
  const work = mkdtempSync(path.join(os.tmpdir(), 'qingcode-tao-'))
  try {
    const cratePath = path.join(work, 'tao.crate')
    writeFileSync(cratePath, buf)
    // 用相对路径 + cwd：Git Bash 的 GNU tar 会把 `C:\...` 当成远程主机。
    execFileSync('tar', ['-xzf', 'tao.crate'], { cwd: work, stdio: 'inherit' })
    const src = path.join(work, `tao-${opts.version}`)
    // 与现有 vendor 保持一致：examples 不参与构建，省体积。
    rmSync(path.join(src, 'examples'), { recursive: true, force: true })

    for (const p of patches) {
      execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', path.join(patchesDir, p)], { cwd: src, stdio: 'inherit' })
      console.log(`已应用 ${p}`)
    }
    if (opts.check) return console.log(`tao ${opts.version} (sha256 ${sha}) 补丁全部可应用（--check，未写入）`)

    const notes = path.join(opts.out, 'QINGCODE.md')
    if (existsSync(notes)) copyFileSync(notes, path.join(src, 'QINGCODE.md'))
    rmSync(opts.out, { recursive: true, force: true })
    mkdirSync(path.dirname(opts.out), { recursive: true })
    // 临时目录可能与仓库不在同一盘符，rename 会 EXDEV，改用复制。
    cpSync(src, opts.out, { recursive: true })
    console.log(`已写入 ${path.relative(root, opts.out)}：tao ${opts.version}，sha256 ${sha}`)
    console.log('记得同步更新 QINGCODE.md 中的版本号与 sha256。')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
