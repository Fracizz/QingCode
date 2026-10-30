import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
const templatePath = new URL('../src-tauri/windows/installer.nsi', import.meta.url)
const closeScript = fileURLToPath(new URL('../src-tauri/windows/close-running-app.ps1', import.meta.url))

test('production installer uses in-place updates and a checked but optional launch action', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert.equal(config.bundle.windows.nsis.template, './windows/installer.nsi')
  const template = readFileSync(templatePath, 'utf8')
  const init = template.match(/Function \.onInit\n([\s\S]*?)FunctionEnd/)[1]
  assert.match(init, /StrCpy \$PassiveMode 1\s+StrCpy \$UpdateMode 1/)
  const finish = template.slice(template.indexOf('; 8. Finish page'), template.indexOf('Function RunMainBinary'))
  assert.match(finish, /!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary/)
  assert.match(finish, /!define MUI_FINISHPAGE_RUN_TEXT "\$\(qingRunQingCode\)"/)
  assert.match(template, /LangString qingRunQingCode \$\{LANG_SIMPCHINESE\} "运行QingCode"/)
  assert.doesNotMatch(finish, /MUI_FINISHPAGE_RUN_NOTCHECKED/)
  assert.doesNotMatch(finish, /SkipIfPassive|MUI_FINISHPAGE_NOAUTOCLOSE/)
  const install = template.match(/Section Install\n([\s\S]*?)SectionEnd/)[1]
  assert.doesNotMatch(install, /CheckIfAppIsRunning/)
  const success = template.match(/Function \.onInstSuccess\n([\s\S]*?)FunctionEnd/)[1]
  assert.doesNotMatch(success, /\$PassiveMode/)
  const hooks = readFileSync(hooksPath, 'utf8')
  const preinstall = hooks.match(/!macro NSIS_HOOK_PREINSTALL\n([\s\S]*?)!macroend/)[1]
  assert.match(preinstall, /!insertmacro QingCloseRunningApp\s+!insertmacro QingRemoveLegacyNavigationComponents/)
})

const windowsDir = process.env.SystemRoot || 'C:\\Windows'
const csc = path.join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const powershell = path.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const skipClose = process.platform !== 'win32' || !existsSync(csc)
  ? 'Requires Windows and the .NET Framework C# compiler.' : false

async function waitForFile(filename, child) {
  const deadline = Date.now() + 10_000
  while (!existsSync(filename)) {
    assert.equal(child.exitCode, null, 'fixture window exited before it was ready')
    assert.ok(Date.now() < deadline, 'fixture window did not open')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

for (const cancelClose of [false, true]) {
  test(`upgrade ${cancelClose ? 'stops when closing is cancelled' : 'closes the target normally'} and preserves another installation`,
    { skip: skipClose }, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'qingcode-close-test-'))
      const children = []
      try {
        const source = path.join(root, 'app.cs')
        const appName = `qingcode-fixture-${process.pid}`
        writeFileSync(source, `
using System;
using System.IO;
using System.Windows.Forms;
class TestApp {
  [STAThread] static void Main(string[] args) {
    var form = new Form();
    form.Text = "Disposable installer test";
    form.Shown += (s, e) => File.WriteAllText(args[0] + ".ready", "ready");
    form.FormClosing += (s, e) => {
      File.WriteAllText(args[0] + ".closing", "normal close requested");
      e.Cancel = args[1] == "cancel";
    };
    Application.Run(form);
  }
}`)
        for (const directory of ['target', 'other']) {
          const folder = path.join(root, directory)
          mkdirSync(folder)
          const exe = path.join(folder, `${appName}.exe`)
          execFileSync(csc, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', `/out:${exe}`, source], { windowsHide: true })
          const marker = path.join(folder, 'marker')
          const child = spawn(exe, [marker, directory === 'other' || cancelClose ? 'cancel' : 'close'], { stdio: 'ignore' })
          children.push(child)
          await waitForFile(`${marker}.ready`, child)
        }
        const sentinel = path.join(root, 'target', 'user-data.json')
        writeFileSync(sentinel, '{"keep":true}')
        const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', closeScript,
          '-ExecutablePath', path.join(root, 'target', `${appName}.exe`), '-TimeoutSeconds', '2'],
        { windowsHide: true, encoding: 'utf8', timeout: 15_000 })
        assert.equal(result.status, cancelClose ? 2 : 0, result.stdout + result.stderr)
        assert.equal(existsSync(path.join(root, 'target', 'marker.closing')), true)
        assert.equal(existsSync(path.join(root, 'other', 'marker.closing')), false)
        assert.equal(children[1].exitCode, null)
        assert.equal(readFileSync(sentinel, 'utf8'), '{"keep":true}')
        if (cancelClose) assert.equal(children[0].exitCode, null)
      } finally {
        // Only terminate the disposable processes created by this test.
        for (const child of children) {
          if (child.exitCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve))
            child.kill()
            await exited
          }
        }
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
        assert.ok(path.basename(root).startsWith('qingcode-close-test-'))
        rmSync(root, { recursive: true, force: true })
      }
    })
}

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
