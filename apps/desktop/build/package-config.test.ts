import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import packageConfig from './package-config.mjs'
import { pruneReleaseVersions } from './release-retention.mjs'

let root: string
let projectDir: string

function setOrigin(url: string) {
  execFileSync('git', ['config', '--local', 'remote.origin.url', url], { cwd: root })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qingcode-package-'))
  projectDir = join(root, 'apps', 'desktop')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ version: '0.0.1' }))
  execFileSync('git', ['init', '--quiet', root])
  vi.stubEnv('QINGCODE_PACKAGE_CHANNEL', undefined)
  vi.stubEnv('QINGCODE_PACKAGE_BASE_VERSION', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('默认出新的 Beta 并在当前工作树预留各自的产物目录', () => {
  setOrigin('https://github.com/example/QingCode.git')
  const first = packageConfig({ projectDir }, undefined, 1000)
  const second = packageConfig({ projectDir }, undefined, 1000)

  expect(first.extraMetadata.version).toBe('0.0.1-beta.1000')
  expect(second.extraMetadata.version).toBe('0.0.1-beta.1001')
  expect(first.directories.output).toBe(join('..', '..', 'release', '0.0.1-beta.1000'))
  expect(existsSync(join(projectDir, first.directories.output))).toBe(true)
  expect(existsSync(join(root, 'release', '0.0.1-beta.1000'))).toBe(true)
  expect(existsSync(join(projectDir, second.directories.output))).toBe(true)
  expect(first.publish).toEqual({
    provider: 'github',
    owner: 'example',
    repo: 'QingCode',
    tagNamePrefix: 'next-v',
    releaseType: 'prerelease',
  })
  expect(JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version).toBe('0.0.1')
})

test('明确选择 stable 时使用正式版本和当前 fork', () => {
  setOrigin('git@github.com:my-fork/QingCode-Next.git')
  vi.stubEnv('QINGCODE_PACKAGE_CHANNEL', 'stable')

  expect(packageConfig({ projectDir })).toEqual({
    extraMetadata: { version: '0.0.1' },
    directories: { output: join('..', '..', 'release', '0.0.1') },
    afterAllArtifactBuild: expect.any(Function),
    publish: {
      provider: 'github',
      owner: 'my-fork',
      repo: 'QingCode-Next',
      tagNamePrefix: 'next-v',
      releaseType: 'release',
    },
  })
})

test('延续源清单中已有的 Beta 版本，并允许无 GitHub origin 的本地构建', () => {
  setOrigin('https://gitee.com/example/qingcode.git')
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ version: '0.0.1-beta.40' }))

  const config = packageConfig({ projectDir }, undefined, 10)
  expect(config.extraMetadata.version).toBe('0.0.1-beta.41')
  expect(config.publish).toBeNull()
})

test('拒绝未知的渠道值', () => {
  vi.stubEnv('QINGCODE_PACKAGE_CHANNEL', 'release')
  expect(() => packageConfig({ projectDir })).toThrow('只支持 beta 或 stable')
  expect(existsSync(join(root, 'release'))).toBe(false)
})

test('指定本次打包的基础版本时仍默认出 Beta', () => {
  vi.stubEnv('QINGCODE_PACKAGE_BASE_VERSION', '0.0.2')
  expect(packageConfig({ projectDir }, undefined, 1000).extraMetadata.version).toBe('0.0.2-beta.1000')
})

test('成功出包后按产物时间保留最近两个已生成版本', () => {
  const release = join(root, 'release')
  const putArtifact = (version: string, time: number, suffix: string) => {
    const folder = join(release, version)
    mkdirSync(folder, { recursive: true })
    const file = join(folder, `QingCode-Next-${version}-${suffix}`)
    writeFileSync(file, 'package')
    utimesSync(file, time, time)
    return file
  }
  putArtifact('0.0.3', 1000, 'Android.apk')
  putArtifact('0.0.2-beta.4', 2000, 'x64.exe')
  mkdirSync(join(release, '0.0.4-beta.1'))
  mkdirSync(join(release, 'notes'))
  const config = packageConfig({ projectDir }, undefined, 3000)
  const version = config.extraMetadata.version
  const file = putArtifact(version, 3000, 'x64.exe')
  const outDir = join(release, version)

  config.afterAllArtifactBuild({ outDir, artifactPaths: [] })
  expect(existsSync(join(release, '0.0.3'))).toBe(true)

  config.afterAllArtifactBuild({ outDir, artifactPaths: [file] })
  expect(existsSync(join(release, '0.0.3'))).toBe(false)
  expect(existsSync(join(release, '0.0.2-beta.4'))).toBe(true)
  expect(existsSync(file)).toBe(true)
  expect(existsSync(join(release, '0.0.4-beta.1'))).toBe(true)
  expect(existsSync(join(release, 'notes'))).toBe(true)
})

test('同层产物和旧目录按版本一起计算，整组清理旧版', () => {
  const release = join(root, 'release')
  mkdirSync(release)
  const put = (directory: string, name: string, time: number) => {
    const file = join(directory, name)
    writeFileSync(file, 'package')
    utimesSync(file, time, time)
    return file
  }
  const oldestExe = put(release, 'QingCode-Next-0.0.3-beta.1-x64.exe', 1000)
  const oldestApk = put(release, 'QingCode-Next-0.0.3-beta.1-android.apk', 1000)
  const oldestChecksum = put(release, 'SHA256SUMS-0.0.3-beta.1.txt', 1000)
  const remainingDir = join(release, '0.0.3-beta.2')
  mkdirSync(remainingDir)
  const oldLayoutExe = put(remainingDir, 'QingCode-Next-0.0.3-beta.2-x64.exe', 2000)
  const flatExe = put(release, 'QingCode-Next-0.0.3-beta.3-x64.exe', 3000)
  const flatApk = put(release, 'QingCode-Next-0.0.3-beta.3-android.apk', 3000)
  const flatChecksum = put(release, 'SHA256SUMS-0.0.3-beta.3.txt', 3000)
  const duplicateDir = join(release, '0.0.3-beta.3')
  mkdirSync(duplicateDir)
  const duplicate = put(duplicateDir, 'QingCode-Next-0.0.3-beta.3-x64.exe', 3000)
  const pending = put(release, 'QingCode-Next-0.0.3-beta.4-x64.exe', 4000)
  const notes = put(release, 'notes.txt', 4000)

  expect(pruneReleaseVersions(release)).toEqual(['0.0.3-beta.1'])
  for (const file of [oldestExe, oldestApk, oldestChecksum]) expect(existsSync(file)).toBe(false)
  for (const file of [oldLayoutExe, flatExe, flatApk, flatChecksum, duplicate, pending, notes]) {
    expect(existsSync(file)).toBe(true)
  }
})
