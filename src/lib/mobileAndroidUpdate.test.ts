import { describe, expect, it } from 'vitest'
// 手机端在线更新：版本换算须与打包脚本一致，挑选只接受 GitHub / Gitee 的 QingCode APK。
import { androidVersionCode as scriptVersionCode } from '../../scripts/android-version.mjs'
import {
  androidVersionCode,
  formatBytes,
  isAllowedApkUrl,
  parseUpdatePrefs,
  pickApkUpdate,
  releaseNotes,
  shouldAutoCheck,
  UPDATE_CHECK_INTERVAL,
} from '../../mobile/android/web/appUpdate.js'

const gh = (version: string) => `https://github.com/Fracizz/QingCode/releases/download/v${version}/QingCode_${version}-android.apk`
const release = (version: string, { prerelease = version.includes('-'), apk = true, draft = false } = {}) => ({
  tag: 'v' + version, prerelease, draft, body: 'notes ' + version, page: 'https://github.com/Fracizz/QingCode/releases/tag/v' + version,
  assets: [
    { name: `QingCode_${version}-windows-x64-setup.exe`, url: gh(version).replace('-android.apk', '-windows-x64-setup.exe'), size: 1 },
    ...(apk ? [{ name: `QingCode_${version}-android.apk`, url: gh(version), size: 2_500_000 }] : []),
  ],
})
const list = (...releases: object[]) => ({ source: 'github', page: 'https://github.com/Fracizz/QingCode/releases', releases })

describe('Android online update', () => {
  it('matches the packaging versionCode formula', () => {
    for (const version of ['0.1.15-beta.3', '0.1.15-alpha.0', '0.1.15-rc.2', '0.1.15', '1.0.0', '209.99.99']) {
      expect(androidVersionCode(version)).toBe(scriptVersionCode(version))
    }
    expect(androidVersionCode('v0.1.15')).toBe(scriptVersionCode('0.1.15'))
    expect(androidVersionCode('0.1')).toBeNull()
    expect(androidVersionCode('0.1.15-beta.300')).toBeNull()
  })

  it('lets beta phones receive newer beta and stable releases', () => {
    const current = { name: '0.1.15-beta.3', code: scriptVersionCode('0.1.15-beta.3') }
    const found = pickApkUpdate(list(release('0.1.15-beta.4'), release('0.1.15-beta.2'), release('0.1.14')), current)
    expect(found).toMatchObject({ version: '0.1.15-beta.4', prerelease: true, url: gh('0.1.15-beta.4'), size: 2_500_000, notes: 'notes 0.1.15-beta.4', source: 'github' })
    expect(pickApkUpdate(list(release('0.1.15-beta.4'), release('0.1.15')), current)?.version).toBe('0.1.15')
  })

  it('keeps stable phones on stable releases unless prereleases are requested', () => {
    const current = { name: '0.1.15', code: scriptVersionCode('0.1.15') }
    expect(pickApkUpdate(list(release('0.1.16-beta.1')), current)).toBeNull()
    expect(pickApkUpdate(list(release('0.1.16-beta.1')), current, { includePrerelease: true })?.version).toBe('0.1.16-beta.1')
    expect(pickApkUpdate(list(release('0.1.16')), current)?.version).toBe('0.1.16')
  })

  it('skips releases without an APK, drafts, older versions and foreign download hosts', () => {
    const current = { name: '0.1.15-beta.3', code: scriptVersionCode('0.1.15-beta.3') }
    const foreign = { ...release('0.1.16-beta.1'), assets: [{ name: 'QingCode_0.1.16-beta.1-android.apk', url: 'https://evil.example/releases/download/v0.1.16-beta.1/QingCode_0.1.16-beta.1-android.apk' }] }
    expect(pickApkUpdate(list(release('0.1.16-beta.3', { apk: false }), release('0.1.16-beta.2', { draft: true }), foreign, release('0.1.15-beta.3')), current)).toBeNull()
    // 最新发布缺少 APK 时回退到更早但仍更新的版本。
    expect(pickApkUpdate(list(release('0.1.16-beta.3', { apk: false }), release('0.1.16-beta.1')), current)?.version).toBe('0.1.16-beta.1')
    expect(pickApkUpdate(null, current)).toBeNull()
  })

  it('accepts only GitHub / Gitee release attachments for the matching version', () => {
    expect(isAllowedApkUrl(gh('1.2.0'), '1.2.0')).toBe(true)
    expect(isAllowedApkUrl('https://gitee.com/FrancizTest_admin/qing-code/releases/download/v1.2.0/QingCode_1.2.0-android.apk', '1.2.0')).toBe(true)
    expect(isAllowedApkUrl(gh('1.2.0'), '1.2.1')).toBe(false)
    expect(isAllowedApkUrl(gh('1.2.0').replace('https:', 'http:'), '1.2.0')).toBe(false)
    expect(isAllowedApkUrl(gh('1.2.0').replace('github.com', 'github.com:8443'), '1.2.0')).toBe(false)
    expect(isAllowedApkUrl('not a url', '1.2.0')).toBe(false)
  })

  it('checks automatically at most once a day and keeps preferences', () => {
    expect(parseUpdatePrefs(null)).toEqual({ auto: true, lastCheck: 0, skipped: null })
    expect(parseUpdatePrefs('{bad')).toEqual({ auto: true, lastCheck: 0, skipped: null })
    const prefs = parseUpdatePrefs(JSON.stringify({ auto: true, lastCheck: 1_000, skipped: '0.1.16' }))
    expect(prefs.skipped).toBe('0.1.16')
    expect(shouldAutoCheck(prefs, 1_000 + UPDATE_CHECK_INTERVAL - 1)).toBe(false)
    expect(shouldAutoCheck(prefs, 1_000 + UPDATE_CHECK_INTERVAL)).toBe(true)
    expect(shouldAutoCheck(prefs, 500)).toBe(true)
    expect(shouldAutoCheck({ ...prefs, auto: false }, 10 * UPDATE_CHECK_INTERVAL)).toBe(false)
  })

  it('formats notes and sizes', () => {
    expect(releaseNotes('a\r\nb\r')).toBe('a\nb')
    expect(releaseNotes('x'.repeat(5000)).endsWith('\n…')).toBe(true)
    expect(formatBytes(2_500_000)).toBe('2.4 MB')
    expect(formatBytes(300)).toBe('1 KB')
    expect(formatBytes(Number.NaN)).toBe('')
  })
})
