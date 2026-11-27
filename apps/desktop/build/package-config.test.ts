import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import packageConfig from './package-config.mjs'

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
  expect(first.directories.output).toBe(join('release', '0.0.1-beta.1000'))
  expect(existsSync(join(projectDir, first.directories.output))).toBe(true)
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
    directories: { output: join('release', '0.0.1') },
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
  expect(existsSync(join(projectDir, 'release'))).toBe(false)
})

test('指定本次打包的基础版本时仍默认出 Beta', () => {
  vi.stubEnv('QINGCODE_PACKAGE_BASE_VERSION', '0.0.2')
  expect(packageConfig({ projectDir }, undefined, 1000).extraMetadata.version).toBe('0.0.2-beta.1000')
})
