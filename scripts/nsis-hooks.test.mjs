import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const makeNsis = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe')
  : ''
const skip =
  process.platform !== 'win32' || !existsSync(makeNsis)
    ? 'Requires Windows and the Tauri NSIS compiler (installed by tauri build).'
    : false
const hooksPath = fileURLToPath(new URL('../src-tauri/windows/hooks.nsh', import.meta.url))
const componentIds = ['typescript', 'python', 'java', 'rust', 'go']

function nsisString(value) {
  assert.doesNotMatch(value, /[\r\n]/)
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"')
}

function withCleanupInstaller(run) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'qingcode-nsis-hooks-'))
  try {
    const installDir = path.join(tempRoot, 'installed')
    const exe = path.join(tempRoot, 'cleanup.exe')
    const source = path.join(tempRoot, 'cleanup.nsi')
    mkdirSync(installDir)
    // Exercise the actual production cleanup macro without application files,
    // registry changes, shortcuts, or the WebView2 installation flow.
    writeFileSync(
      source,
      `Unicode true
Name "QingCode cleanup test"
OutFile "${nsisString(exe)}"
InstallDir "${nsisString(installDir)}"
RequestExecutionLevel user
SilentInstall silent
!include "${nsisString(hooksPath)}"
Section
  !insertmacro QingRemoveLegacyNavigationComponents
SectionEnd
`
    )
    execFileSync(makeNsis, ['-INPUTCHARSET', 'UTF8', '-V2', source], { windowsHide: true })
    run(installDir, () => execFileSync(exe, ['/S'], { windowsHide: true, timeout: 30_000 }))
  } finally {
    // Verify the exact temporary directory before recursive test cleanup.
    assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()))
    assert.ok(path.basename(tempRoot).startsWith('qingcode-nsis-hooks-'))
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test(
  'upgrade removes retired navigation components and preserves unrelated files',
  { skip },
  () => {
    withCleanupInstaller((installDir, cleanup) => {
      const componentRoot = path.join(installDir, 'language-components')
      for (const id of componentIds) {
        const directory = path.join(componentRoot, id)
        mkdirSync(directory, { recursive: true })
        writeFileSync(path.join(directory, `qingcode_language_${id}.dll`), 'old component')
        writeFileSync(path.join(directory, 'component.json'), '{}')
      }
      const userFile = path.join(componentRoot, 'python', 'notes.txt')
      const appFile = path.join(installDir, 'qingcode.exe')
      writeFileSync(userFile, 'keep this file')
      writeFileSync(appFile, 'application')

      cleanup()

      for (const id of componentIds) {
        assert.equal(existsSync(path.join(componentRoot, id, `qingcode_language_${id}.dll`)), false)
        assert.equal(existsSync(path.join(componentRoot, id, 'component.json')), false)
        if (id !== 'python') assert.equal(existsSync(path.join(componentRoot, id)), false)
      }
      assert.equal(readFileSync(userFile, 'utf8'), 'keep this file')
      assert.equal(readFileSync(appFile, 'utf8'), 'application')
    })
  }
)

test(
  'cleanup handles clean installs and removes empty legacy directories repeatedly',
  { skip },
  () => {
    withCleanupInstaller((installDir, cleanup) => {
      cleanup()
      const componentRoot = path.join(installDir, 'language-components')
      for (const id of componentIds) mkdirSync(path.join(componentRoot, id), { recursive: true })

      cleanup()
      cleanup()

      assert.equal(existsSync(componentRoot), false)
      assert.equal(existsSync(installDir), true)
    })
  }
)
