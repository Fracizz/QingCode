import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const versionPattern = String.raw`\d+\.\d+\.\d+(?:-beta\.\d+)?`
const versionName = new RegExp(`^${versionPattern}$`)
const manifestName = new RegExp(String.raw`^SHA256SUMS-(${versionPattern})\.txt$`)
const artifactSuffixes = ['x64.exe', 'android.apk', 'Android.apk', 'x64.zip']

export function pruneReleaseVersions(releaseDir) {
  if (!lstatSync(releaseDir, { throwIfNoEntry: false })?.isDirectory()) return []

  const versions = new Map()
  function collect(name, directory, container) {
    const artifacts = artifactSuffixes.flatMap((suffix) => {
      const path = join(directory, `QingCode-Next-${name}-${suffix}`)
      const stat = lstatSync(path, { throwIfNoEntry: false })
      return stat?.isFile() && stat.size > 0 ? [{ path, modifiedAt: stat.mtimeMs }] : []
    })
    if (artifacts.length === 0) return
    const version = versions.get(name) ?? { name, modifiedAt: -Infinity, paths: new Set() }
    version.modifiedAt = Math.max(version.modifiedAt, ...artifacts.map(({ modifiedAt }) => modifiedAt))
    version.paths.add(container)
    if (directory === releaseDir) {
      for (const { path } of artifacts) version.paths.add(path)
    }
    versions.set(name, version)
  }

  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    const path = join(releaseDir, entry.name)
    if (entry.isDirectory() && versionName.test(entry.name)) {
      collect(entry.name, path, path)
    } else if (entry.isFile()) {
      // 校验清单最后落盘，忽略尚未收齐的版本。
      const manifest = manifestName.exec(entry.name)
      if (manifest) collect(manifest[1], releaseDir, path)
    }
  }

  const recentFirst = [...versions.values()]
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name, 'en', { numeric: true }))
  return recentFirst.slice(2).map(({ name, paths }) => {
    for (const path of paths) rmSync(path, { recursive: true, force: true })
    return name
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDir = resolve(import.meta.dirname, '../../../release')
  for (const name of pruneReleaseVersions(releaseDir)) console.log(`已移除旧版本 ${name}`)
}
