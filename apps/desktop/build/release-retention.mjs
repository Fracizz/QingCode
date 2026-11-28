import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const versionName = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/

export function pruneReleaseVersions(releaseDir) {
  if (!lstatSync(releaseDir, { throwIfNoEntry: false })?.isDirectory()) return []

  const versions = []
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !versionName.test(entry.name)) continue
    const prefix = `QingCode-Next-${entry.name}-`
    const directory = join(releaseDir, entry.name)
    const artifacts = ['x64.exe', 'android.apk', 'Android.apk', 'x64.zip']
      .map((suffix) => lstatSync(join(directory, prefix + suffix), { throwIfNoEntry: false }))
      .filter((stat) => stat?.isFile() && stat.size > 0)
    if (artifacts.length) {
      versions.push({ name: entry.name, modifiedAt: Math.max(...artifacts.map((stat) => stat.mtimeMs)) })
    }
  }

  versions.sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name, 'en', { numeric: true }))
  return versions.slice(2).map(({ name }) => {
    rmSync(join(releaseDir, name), { recursive: true })
    return name
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseDir = resolve(import.meta.dirname, '../../../release')
  for (const name of pruneReleaseVersions(releaseDir)) console.log(`已移除旧版本 ${name}`)
}
