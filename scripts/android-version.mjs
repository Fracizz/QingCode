#!/usr/bin/env node
// 由 package.json 版本推导 Android versionName / versionCode，保证每次发布单调递增。
// 用法：node scripts/android-version.mjs [version]  → 输出 JSON { name, code }
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CHANNELS = { alpha: 0, beta: 300, rc: 600 }
const STABLE = 999

/**
 * major.minor.patch[-channel.n] → major*10^7 + minor*10^5 + patch*10^3 + 预发布序号。
 * 正式版取 999，排在同号所有预发布之后；上限 2.1e9（Android versionCode 最大值）。
 */
export function androidVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(version)
  if (!match) throw new Error(`Unsupported version for Android: ${version}`)
  const [, major, minor, patch, channel, serial] = match
  const [maj, min, pat] = [major, minor, patch].map(Number)
  if (maj > 209 || min > 99 || pat > 99) throw new Error(`Version component out of range: ${version}`)
  let pre = STABLE
  if (channel) {
    const n = Number(serial)
    if (n > 299) throw new Error(`Prerelease number out of range: ${version}`)
    pre = CHANNELS[channel] + n
  }
  return maj * 10_000_000 + min * 100_000 + pat * 1_000 + pre
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  process.stdout.write(JSON.stringify({ name: version, code: androidVersionCode(version) }))
}
