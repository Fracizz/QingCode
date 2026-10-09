import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('./canonical-release-assets.ps1', import.meta.url))

test('release selection supplies six separate upload paths in canonical order', () => {
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
