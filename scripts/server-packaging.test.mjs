import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('./package-common.ps1', import.meta.url))
const installerSource = fileURLToPath(new URL('./package-installer.ps1', import.meta.url))
const options = { skip: process.platform !== 'win32' ? 'Requires Windows packaging tooling.' : false }
const version = '1.2.3-beta.4'

test('Windows installer keeps Server binaries in the standalone offline pack', () => {
  const installer = readFileSync(installerSource, 'utf8')
  assert.match(installer, /Publish-ServerOfflinePack/)
  assert.doesNotMatch(installer, /Publish-ServerBinariesToResourceDir/)
  assert.doesNotMatch(installer, /resources[\\/]servers/)
  assert.match(installer, /not inside the installer/)
})

function withPackage(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qingcode-server-package-'))
  try {
    const output = path.join(root, 'src-tauri', 'target', 'server')
    mkdirSync(output, { recursive: true })
    mkdirSync(path.join(root, 'src-tauri', 'qingcode-server'))
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
    writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version }))
    for (const cargo of ['Cargo.toml', 'qingcode-server/Cargo.toml']) {
      writeFileSync(path.join(root, 'src-tauri', cargo), `[package]\nversion = "${version}"\n`)
    }
    const artifacts = {}
    for (const name of ['qingcode-server-x86_64', 'qingcode-server-aarch64', 'qingcode-server-windows-x86_64.exe']) {
      const contents = Buffer.from(`current binary: ${name}`)
      writeFileSync(path.join(output, name), contents)
      artifacts[name] = { sha256: createHash('sha256').update(contents).digest('hex'), size: contents.length }
    }
    const manifest = { version, artifacts }
    const saveManifest = () => writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest))
    saveManifest()
    const probe = path.join(root, 'probe.ps1')
    writeFileSync(probe, `
param([string]$Source, [string]$ProjectRoot, [string]$Action)
$ErrorActionPreference = 'Stop'
. $Source
try {
  switch ($Action) {
    'publish' {
      Publish-ServerBinariesToResourceDir -ProjectRoot $ProjectRoot | Out-Null
      Publish-ServerOfflinePack -ProjectRoot $ProjectRoot
      Expand-Archive -LiteralPath (Join-Path $ProjectRoot 'release/QingCode-servers.zip') -DestinationPath (Join-Path $ProjectRoot 'unpacked')
    }
    'clear' { Clear-ServerResourceDir -ProjectRoot $ProjectRoot }
    'reuse' { Invoke-ServerBinaryBuild -ProjectRoot $ProjectRoot -SkipServer }
    default { Get-ServerBinaryFiles -ProjectRoot $ProjectRoot | Out-Null }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`)
    const invoke = (action = 'validate') => execFileSync('pwsh', [
      '-NoProfile', '-File', probe, '-Source', source, '-ProjectRoot', root, '-Action', action,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: 'pipe' })
    run({ root, output, manifest, saveManifest, invoke })
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('qingcode-server-package-'))
    rmSync(root, { recursive: true, force: true })
  }
}

test('publishes matching binaries and manifest to installer staging, portable directory and offline zip', options, () => {
  withPackage(({ root, output, manifest, saveManifest, invoke }) => {
    const stage = path.join(root, 'src-tauri', 'resources', 'servers')
    const portable = path.join(root, 'release', 'servers')
    for (const dir of [stage, portable]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'qingcode-server-windows-aarch64.exe'), 'obsolete architecture')
      writeFileSync(path.join(dir, 'manifest.json'), '{"version":"old"}')
      writeFileSync(path.join(dir, 'notes.txt'), 'preserve user files')
    }
    writeFileSync(path.join(stage, '.gitignore'), '*')
    // A leftover output from another build must never bypass the current manifest.
    writeFileSync(path.join(output, 'qingcode-server-windows-aarch64.exe'), 'old output')
    invoke('publish')
    for (const dir of [stage, portable, path.join(root, 'unpacked')]) {
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')), manifest)
      for (const name of Object.keys(manifest.artifacts)) {
        assert.deepEqual(readFileSync(path.join(dir, name)), readFileSync(path.join(output, name)))
      }
      assert.equal(existsSync(path.join(dir, 'qingcode-server-windows-aarch64.exe')), false)
    }
    // Repack the same version: both the relative directory and zip must replace
    // existing files, even when their names and version have not changed.
    const name = 'qingcode-server-x86_64'
    const updated = Buffer.from('rebuilt server with the same version')
    writeFileSync(path.join(output, name), updated)
    manifest.artifacts[name] = {
      sha256: createHash('sha256').update(updated).digest('hex'), size: updated.length,
    }
    saveManifest()
    writeFileSync(path.join(portable, name), 'stale directory copy')
    writeFileSync(path.join(portable, 'manifest.json'), '{"version":"stale"}')
    rmSync(path.join(root, 'unpacked'), { recursive: true })
    invoke('publish')
    for (const dir of [stage, portable, path.join(root, 'unpacked')]) {
      assert.deepEqual(readFileSync(path.join(dir, name)), updated)
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')), manifest)
    }
    invoke('clear')
    for (const name of [...Object.keys(manifest.artifacts), 'manifest.json']) {
      assert.equal(existsSync(path.join(stage, name)), false)
    }
    assert.equal(readFileSync(path.join(stage, '.gitignore'), 'utf8'), '*')
    assert.equal(readFileSync(path.join(portable, 'notes.txt'), 'utf8'), 'preserve user files')
    assert.equal(existsSync(path.join(root, 'unpacked', 'notes.txt')), false)
  })
})

for (const action of ['validate', 'reuse']) {
  test(`${action} rejects a stale server package before publishing`, options, () => {
    withPackage(({ manifest, saveManifest, invoke }) => {
      manifest.version = '0.0.1'
      saveManifest()
      assert.throws(() => invoke(action), /Server\/client version mismatch/)
    })
  })
}

test('rejects modified binaries with unchanged size, truncated binaries and missing files', options, () => {
  withPackage(({ output, invoke }) => {
    const binary = path.join(output, 'qingcode-server-x86_64')
    const contents = readFileSync(binary)
    writeFileSync(binary, Buffer.alloc(contents.length, 0))
    assert.throws(() => invoke(), /SHA-256 mismatch/)
    writeFileSync(binary, 'truncated')
    assert.throws(() => invoke(), /size mismatch/)
    rmSync(binary)
    assert.throws(() => invoke(), /does not exist/)
  })
})

test('rejects missing manifests, incomplete architecture sets and unsafe artifact names', options, () => {
  withPackage(({ output, manifest, saveManifest, invoke }) => {
    rmSync(path.join(output, 'manifest.json'))
    assert.throws(() => invoke(), /Server manifest missing/)
    const arm = manifest.artifacts['qingcode-server-aarch64']
    delete manifest.artifacts['qingcode-server-aarch64']
    saveManifest()
    assert.throws(() => invoke(), /missing required artifact/)
    manifest.artifacts['qingcode-server-aarch64'] = arm
    manifest.artifacts['../qingcode-server-outside'] = arm
    saveManifest()
    assert.throws(() => invoke(), /Invalid server artifact name/)
  })
})

test('rejects client / tauri / Rust version drift even with a current server manifest', options, () => {
  withPackage(({ root, invoke }) => {
    const tauri = path.join(root, 'src-tauri', 'tauri.conf.json')
    writeFileSync(tauri, '{"version":"old"}')
    assert.throws(() => invoke(), /Server\/client version mismatch/)
    writeFileSync(tauri, JSON.stringify({ version }))
    writeFileSync(path.join(root, 'src-tauri', 'qingcode-server', 'Cargo.toml'), '[package]\nversion = "old"\n')
    assert.throws(() => invoke(), /version mismatch in src-tauri\/qingcode-server\/Cargo.toml/)
  })
})
