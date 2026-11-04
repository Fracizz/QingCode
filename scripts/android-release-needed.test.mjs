import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { androidReleaseNeeded, latestApkRelease } from './android-release-needed.mjs'

test('baseline is the latest published release containing its own APK, including prereleases', () => {
  const release = (tag, date, assets, draft = false) => ({ tag_name: tag, published_at: date, assets: assets.map(name => ({ name })), draft })
  assert.equal(latestApkRelease([
    release('v1.0.0', '2026-10-01', ['QingCode_1.0.0-android.apk']),
    release('v1.0.1', '2026-10-03', ['desktop.exe']),
    release('v1.0.2-beta.1', '2026-10-02', ['QingCode_1.0.2-beta.1-android.apk']),
    release('v1.0.3', '2026-10-04', ['QingCode_1.0.3-android.apk'], true),
  ]), 'v1.0.2-beta.1')
  assert.equal(latestApkRelease([]), undefined)
})

test('APK builds track Android inputs across intervening desktop-only releases', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qingcode-android-release-'))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), content)
  }
  const commit = () => {
    git(['add', '-A'])
    git(['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', 'commit', '-qm', 'fixture'])
  }
  try {
    git(['init', '-q'])
    write('package.json', JSON.stringify({ version: '1.0.0', dependencies: { '@xterm/xterm': '6.0.0' } }))
    write('mobile/android/web/app.js', 'original')
    commit()
    git(['tag', 'v1.0.0'])
    assert.equal(androidReleaseNeeded(undefined, root).needed, true)
    assert.equal(androidReleaseNeeded('v1.0.0', root).needed, false)
    write('package.json', JSON.stringify({ version: '1.0.1', dependencies: { '@xterm/xterm': '6.0.0' } }))
    write('src/Desktop.tsx', 'desktop-only')
    commit()
    git(['tag', 'v1.0.1'])
    assert.equal(androidReleaseNeeded('v1.0.0', root).needed, false)
    write('mobile/android/web/app.js', 'updated')
    commit()
    assert.equal(androidReleaseNeeded('v1.0.0', root).needed, true)
    git(['tag', 'v1.0.2'])
    write('package.json', JSON.stringify({ version: '1.0.3', dependencies: { '@xterm/xterm': '6.0.1' } }))
    commit()
    assert.equal(androidReleaseNeeded('v1.0.2', root).needed, true)
    git(['tag', 'v1.0.3'])
    write('scripts/build-android.ps1', 'updated build')
    commit()
    assert.equal(androidReleaseNeeded('v1.0.3', root).needed, true)
    git(['tag', 'v1.0.4'])
    write('pnpm-lock.yaml', 'updated dependency resolution')
    commit()
    assert.equal(androidReleaseNeeded('v1.0.4', root).needed, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
