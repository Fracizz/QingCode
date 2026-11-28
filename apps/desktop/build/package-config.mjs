import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pruneReleaseVersions } from './release-retention.mjs'

function readGitHubOrigin(projectDir) {
  let origin
  try {
    origin = execFileSync('git', ['config', '--local', '--get', 'remote.origin.url'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
  } catch {
    return null
  }

  const match = /^(?:https:\/\/(?:[^/@\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z\d-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(origin)
  return match && { owner: match[1], repo: match[2] }
}

function reserveBetaVersion(releaseDir, baseVersion, firstBuild) {
  mkdirSync(releaseDir, { recursive: true })
  // 同一工作树同时出包时，每个打包进程都需要独立的 win-unpacked 目录。
  for (let build = firstBuild; Number.isSafeInteger(build); build++) {
    const version = `${baseVersion}-beta.${build}`
    try {
      mkdirSync(join(releaseDir, version))
      return version
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('桌面应用的 Beta 序号超出范围')
}

export default function packageConfig(
  { projectDir },
  channel = process.env.QINGCODE_PACKAGE_CHANNEL ?? 'beta',
  now = Date.now(),
) {
  if (channel !== 'beta' && channel !== 'stable') {
    throw new Error('QINGCODE_PACKAGE_CHANNEL 只支持 beta 或 stable')
  }

  const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
  const match = /^(\d+\.\d+\.\d+)(?:-beta\.(\d+))?$/.exec(manifest.version)
  if (!match) throw new Error('桌面应用版本必须为 X.Y.Z 或 X.Y.Z-beta.N')

  const [, manifestBase, sourceBeta] = match
  const baseVersion = process.env.QINGCODE_PACKAGE_BASE_VERSION ?? manifestBase
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(baseVersion)) {
    throw new Error('QINGCODE_PACKAGE_BASE_VERSION 必须为 X.Y.Z')
  }
  const previousBeta = baseVersion === manifestBase ? Number(sourceBeta ?? 0) : 0
  const outputRoot = join('..', '..', 'release')
  const releaseDir = resolve(projectDir, outputRoot)
  const version = channel === 'stable'
    ? baseVersion
    : reserveBetaVersion(releaseDir, baseVersion, Math.max(now, previousBeta + 1))
  const repository = readGitHubOrigin(projectDir)
  return {
    extraMetadata: { version },
    directories: { output: join(outputRoot, version) },
    afterAllArtifactBuild({ outDir, artifactPaths }) {
      // 只在仓库根的安装包出完后清理，Windows 构建机可以指定自己的中间目录。
      const directory = resolve(outDir)
      const installer = join(directory, `QingCode-Next-${version}-x64.exe`)
      if (dirname(directory) === releaseDir && artifactPaths.some((file) => resolve(file) === installer)) {
        for (const name of pruneReleaseVersions(releaseDir)) console.log(`已移除旧版本 ${name}`)
      }
    },
    publish: repository && {
      provider: 'github',
      ...repository,
      // Next 与旧版共用 GitHub 仓库，旧版工作流由 v* 标签触发。
      tagNamePrefix: 'next-v',
      releaseType: channel === 'stable' ? 'release' : 'prerelease',
    },
  }
}
