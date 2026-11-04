import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const androidPaths = [
  'mobile/android',
  'scripts/build-android.ps1',
  'scripts/android-version.mjs',
  'src-tauri/icons/128x128@2x.png',
  'pnpm-lock.yaml',
]
const bundledDependencies = ['@xterm/xterm', '@xterm/addon-fit', 'jsqr']

export function latestApkRelease(releases) {
  return releases
    .filter(release => !release.draft && /^v\d/.test(release.tag_name)
      && release.assets?.some(asset => asset.name === `QingCode_${release.tag_name.slice(1)}-android.apk`))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]?.tag_name
}

export function androidReleaseNeeded(base, cwd = process.cwd()) {
  if (!base) return { needed: true, reason: 'No published Android APK exists.' }
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
  // Full tag history is checked out by the release meta job. A missing baseline is an error.
  git(['rev-parse', '--verify', `${base}^{commit}`])
  const changed = git(['diff', '--name-only', base, 'HEAD', '--', ...androidPaths])
  if (changed) return { needed: true, reason: `Android build inputs changed since ${base}: ${changed.split('\n').join(', ')}` }
  const before = JSON.parse(git(['show', `${base}:package.json`]))
  const after = JSON.parse(git(['show', 'HEAD:package.json']))
  const dependency = (pkg, name) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
  if (bundledDependencies.some(name => dependency(before, name) !== dependency(after, name))) {
    return { needed: true, reason: `Bundled Android dependencies changed since ${base}.` }
  }
  return { needed: false, reason: `Android inputs unchanged since ${base}; reuse that release's APK.` }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pages = JSON.parse(execFileSync('gh', [
    'api', '--paginate', '--slurp', `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`,
  ], { encoding: 'utf8', windowsHide: true }))
  const baseline = latestApkRelease(pages.flat())
  const result = androidReleaseNeeded(baseline)
  console.log(result.reason)
  appendFileSync(process.env.GITHUB_OUTPUT, `needed=${result.needed}\nbaseline=${baseline ?? ''}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Android APK\n\n${result.reason}\n`)
  }
}
