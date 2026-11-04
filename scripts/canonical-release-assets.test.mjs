import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('./canonical-release-assets.ps1', import.meta.url))

function selectReleaseFiles(names) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qingcode-release-assets-'))
  try {
    for (const name of names) writeFileSync(path.join(root, name), name)
    writeFileSync(path.join(root, 'obsolete.exe'), 'excluded')
    const probe = path.join(root, 'probe.ps1')
    writeFileSync(probe, `
param([string]$Source, [string]$AssetDirectory)
$ErrorActionPreference = 'Stop'
. $Source
$paths = @(Get-ChildItem -LiteralPath $AssetDirectory -File | ForEach-Object { $_.FullName })
$files = @(Select-CanonicalReleaseFiles -Version 'v1.2.3-beta.2' -Paths $paths)
$contents = @(foreach ($file in $files) { Get-Content -LiteralPath $file -Raw })
ConvertTo-Json -InputObject $contents -Compress
`)
    const output = execFileSync('pwsh', [
      '-NoProfile', '-File', probe, '-Source', source, '-AssetDirectory', root,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    return JSON.parse(output.trim())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('release selection appends the optional Android APK when it was built', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell release tooling.' : false,
}, () => {
  const required = [
    'QingCode_1.2.3-beta.2-windows-x64.exe',
    'QingCode_1.2.3-beta.2-windows-x64-setup.exe',
    'QingCode_1.2.3-beta.2-windows-arm64.exe',
    'QingCode_1.2.3-beta.2-windows-arm64-setup.exe',
    'QingCode_1.2.3-beta.2-macos-arm64.dmg',
    'QingCode_1.2.3-beta.2-macos-arm64.zip',
  ]
  const apk = 'QingCode_1.2.3-beta.2-android.apk'
  assert.deepEqual(selectReleaseFiles([apk, ...required]), [...required, apk])
  assert.deepEqual(selectReleaseFiles(required), required)
})

test('release selection supplies six separate upload paths in canonical order', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell release tooling.' : false,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qingcode-release-assets-'))
  const names = [
    'QingCode_1.2.3-beta.2-windows-x64.exe',
    'QingCode_1.2.3-beta.2-windows-x64-setup.exe',
    'QingCode_1.2.3-beta.2-windows-arm64.exe',
    'QingCode_1.2.3-beta.2-windows-arm64-setup.exe',
    'QingCode_1.2.3-beta.2-macos-arm64.dmg',
    'QingCode_1.2.3-beta.2-macos-arm64.zip',
  ]
  try {
    for (const name of names) writeFileSync(path.join(root, name), name)
    writeFileSync(path.join(root, 'obsolete.exe'), 'excluded')
    const probe = path.join(root, 'probe.ps1')
    writeFileSync(probe, `
param([string]$Source, [string]$AssetDirectory)
$ErrorActionPreference = 'Stop'
. $Source
$paths = @(Get-ChildItem -LiteralPath $AssetDirectory -File | ForEach-Object { $_.FullName })
$files = @(Select-CanonicalReleaseFiles -Version 'v1.2.3-beta.2' -Paths $paths)
# The publisher passes each item to a string parameter, then opens that file.
function Read-UploadFile([string]$FilePath) {
  Get-Content -LiteralPath $FilePath -Raw
}
$contents = @(foreach ($file in $files) { Read-UploadFile -FilePath $file })
ConvertTo-Json -InputObject $contents -Compress
`)
    const output = execFileSync('pwsh', [
      '-NoProfile', '-File', probe, '-Source', source, '-AssetDirectory', root,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.deepEqual(JSON.parse(output.trim()), names)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('qingcode-release-assets-'))
    rmSync(root, { recursive: true, force: true })
  }
})
