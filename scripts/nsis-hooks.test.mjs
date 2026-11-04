import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

test('production installer confirms first installs, detects upgrades and offers a checked but optional launch action', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert.equal(config.bundle.windows.nsis.template, './windows/installer.nsi')
  const template = readFileSync(templatePath, 'utf8').replaceAll('\r\n', '\n')
  const init = template.match(/Function \.onInit\n([\s\S]*?)FunctionEnd/)[1]
  assert.match(init, /StrCpy \$PassiveMode 0\s+StrCpy \$UpdateMode 0/)
  assert.doesNotMatch(init, /StrCpy \$PassiveMode 1\s+StrCpy \$UpdateMode 1/)
  assert.match(init, /Call RestorePreviousInstallLocation[\s\S]*Call QingConfigureInstallMode/)
  assert.match(template, /LangString qingStartInstall \$\{LANG_SIMPCHINESE\} "开始安装"/)
  assert.match(template, /MUI_PAGE_CUSTOMFUNCTION_SHOW QingShowStartInstall\n!insertmacro MUI_PAGE_DIRECTORY/)
  assert.doesNotMatch(template, /!insertmacro MUI_PAGE_WELCOME/)
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
  const hooks = readFileSync(hooksPath, 'utf8').replaceAll('\r\n', '\n')
  const preinstall = hooks.match(/!macro NSIS_HOOK_PREINSTALL\n([\s\S]*?)!macroend/)[1]
  assert.match(preinstall, /!insertmacro QingCloseRunningApp\s+!insertmacro QingRemoveLegacyNavigationComponents/)
})

const windowsDir = process.env.SystemRoot || 'C:\\Windows'
const csc = path.join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const powershell = path.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const powershell32 = path.join(windowsDir, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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

const closeScenarios = [powershell, powershell32].flatMap(shell =>
  ['graceful', 'cancel', 'check', 'force'].map(mode => ({ shell, mode })))
for (const mode of ['installer-yes', 'installer-no', 'installer-silent', 'installer-absent']) {
  closeScenarios.push({ shell: powershell, mode })
}
for (const { shell, mode } of closeScenarios) {
  test(`upgrade shutdown mode ${mode} via ${shell === powershell32 ? '32-bit' : 'native'} PowerShell preserves another installation`,
    { skip: skipClose || (mode.startsWith('installer-') && skip) }, async () => {
      const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'qingcode-close-test-')))
      const children = []
      try {
        const source = path.join(root, 'app.cs')
        const appName = `qingcode-fixture-${process.pid}`
        writeFileSync(source, `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
class TestApp {
  delegate bool WindowCallback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  static void Answer(string[] args) {
    var deadline = DateTime.UtcNow.AddSeconds(20);
    IntPtr dialog = IntPtr.Zero;
    while (dialog == IntPtr.Zero && DateTime.UtcNow < deadline) {
      EnumWindows((window, data) => {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner == uint.Parse(args[1]) && GetDlgItem(window, 6) != IntPtr.Zero) dialog = window;
        return true;
      }, IntPtr.Zero);
      Thread.Sleep(50);
    }
    if (dialog == IntPtr.Zero) throw new Exception("Confirmation dialog did not appear");
    int defaultId = SendMessage(dialog, 0x400, IntPtr.Zero, IntPtr.Zero).ToInt32() & 0xffff;
    if (defaultId != 7) throw new Exception("No must be the default button");
    var text = new StringBuilder(2048);
    GetWindowText(GetDlgItem(dialog, 65535), text, text.Capacity);
    File.WriteAllText(args[3], text.ToString());
    SendMessage(GetDlgItem(dialog, int.Parse(args[2])), 0xf5, IntPtr.Zero, IntPtr.Zero);
    if (args[2] == "7") {
      bool closed = false;
      while (!closed && DateTime.UtcNow < deadline) {
        EnumWindows((window, data) => {
          uint owner;
          GetWindowThreadProcessId(window, out owner);
          var button = GetDlgItem(window, 2);
          if (owner == uint.Parse(args[1]) && button != IntPtr.Zero && IsWindowEnabled(window) && IsWindowEnabled(button)) {
            SendMessage(button, 0xf5, IntPtr.Zero, IntPtr.Zero);
            closed = true;
          }
          return true;
        }, IntPtr.Zero);
        Thread.Sleep(50);
      }
      if (!closed) throw new Exception("Aborted installation did not become closable");
    }
  }
  [STAThread] static void Main(string[] args) {
    if (args[0] == "answer") { Answer(args); return; }
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
          // Force an x64 process: AnyCPU fixtures can hide NSIS's WOW64 bug.
          execFileSync(csc, ['/nologo', '/platform:x64', '/target:winexe', '/reference:System.Windows.Forms.dll', `/out:${exe}`, source], { windowsHide: true })
          const marker = path.join(folder, 'marker')
          if (mode === 'installer-absent' && directory === 'target') continue
          const child = spawn(exe, [marker, directory === 'other' || mode !== 'graceful' ? 'cancel' : 'close'], { stdio: 'ignore' })
          children.push(child)
          await waitForFile(`${marker}.ready`, child)
        }
        const sentinel = path.join(root, 'target', 'user-data.json')
        writeFileSync(sentinel, '{"keep":true}')
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', closeScript,
          '-ExecutablePath', path.join(root, 'target', `${appName}.exe`), '-TimeoutSeconds', '2']
        if (mode === 'check') args.push('-CheckOnly')
        if (mode === 'force') args.push('-Force')
        const staysRunning = ['cancel', 'check', 'installer-no', 'installer-silent'].includes(mode)
        if (mode.startsWith('installer-')) {
          const installer = path.join(root, 'setup.exe')
          const nsi = path.join(root, 'setup.nsi')
          const completed = path.join(root, 'completed')
          const translations = readFileSync(templatePath, 'utf8').split(/\r?\n/)
            .filter(line => /^LangString qing(?:ConfirmForceClose|CloseCancelled|CloseFailed) /.test(line)).join('\n')
          writeFileSync(nsi, `Unicode true
!include MUI2.nsh
!include x64.nsh
!include "${nsisString(hooksPath)}"
!define MAINBINARYNAME "${appName}"
Name "QingCode disposable shutdown test"
OutFile "${nsisString(installer)}"
InstallDir "${nsisString(path.join(root, 'target'))}"
RequestExecutionLevel user
AutoCloseWindow true
Page instfiles "" StartTestInstall
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
${translations}
Function .onInit
  StrCpy $LANGUAGE 2052
FunctionEnd
Function StartTestInstall
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x111, p 1, p 0)'
FunctionEnd
Function .onInstSuccess
  Quit
FunctionEnd
Function .onInstFailed
  Quit
FunctionEnd
Section
  !insertmacro QingCloseRunningApp
  FileOpen $2 "${nsisString(completed)}" w
  FileWrite $2 "installed"
  FileClose $2
SectionEnd
`)
          execFileSync(makeNsis, ['-INPUTCHARSET', 'UTF8', '-V2', nsi], { windowsHide: true })
          const setup = spawn(installer, mode === 'installer-silent' ? ['/S'] : [], { stdio: 'ignore' })
          children.push(setup)
          const setupExit = new Promise(resolve => setup.once('exit', resolve))
          if (mode === 'installer-yes' || mode === 'installer-no') {
            const dialogText = path.join(root, 'dialog.txt')
            execFileSync(path.join(root, 'other', `${appName}.exe`),
              ['answer', String(setup.pid), mode === 'installer-yes' ? '6' : '7', dialogText], { timeout: 30_000 })
            assert.match(readFileSync(dialogText, 'utf8'), /是否强制关闭/)
            assert.match(readFileSync(dialogText, 'utf8'), /未保存/)
          }
          const watchdog = setTimeout(() => setup.kill(), 30_000)
          try {
            assert.equal(await setupExit, staysRunning ? 2 : 0)
          } finally {
            clearTimeout(watchdog)
          }
          assert.equal(existsSync(completed), !staysRunning)
        } else {
          const result = spawnSync(shell, args,
          { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
          assert.equal(result.status, staysRunning ? 2 : 0, result.stdout + result.stderr)
        }
        assert.equal(existsSync(path.join(root, 'target', 'marker.closing')), mode === 'graceful' || mode === 'cancel')
        assert.equal(existsSync(path.join(root, 'other', 'marker.closing')), false)
        assert.equal(children[mode === 'installer-absent' ? 0 : 1].exitCode, null)
        assert.equal(readFileSync(sentinel, 'utf8'), '{"keep":true}')
        const stillRunning = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', closeScript,
          '-ExecutablePath', path.join(root, 'target', `${appName}.exe`), '-CheckOnly'],
        { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
        assert.equal(stillRunning.status, staysRunning ? 2 : 0, stillRunning.stdout + stillRunning.stderr)
      } finally {
        // Only terminate the disposable processes created by this test.
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve))
            child.kill()
            await exited
          }
        }
        assert.equal(path.dirname(root), realpathSync.native(os.tmpdir()))
        assert.ok(path.basename(root).startsWith('qingcode-close-test-'))
        rmSync(root, { recursive: true, force: true })
      }
    })
}

test('upgrade refuses to proceed while another process locks the executable', { skip: skipClose }, () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'qingcode-close-test-')))
  try {
    const exe = path.join(root, 'locked-fixture.exe')
    writeFileSync(exe, 'keep existing executable intact')
    const probe = path.join(root, 'lock.ps1')
    writeFileSync(probe, `
param([string]$ExecutablePath, [string]$CloseScript)
$lock = [IO.File]::Open($ExecutablePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  & '${powershell.replaceAll("'", "''")}' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $CloseScript -ExecutablePath $ExecutablePath -TimeoutSeconds 1
  $code = $LASTEXITCODE
} finally { $lock.Dispose() }
exit $code
`)
    const result = spawnSync(powershell32, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
      '-ExecutablePath', exe, '-CloseScript', closeScript], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.match(result.stdout, /executable is locked/)
    assert.equal(readFileSync(exe, 'utf8'), 'keep existing executable intact')
  } finally {
    assert.equal(path.dirname(root), realpathSync.native(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('qingcode-close-test-'))
    rmSync(root, { recursive: true, force: true })
  }
})

function nsisString(value) {
  assert.doesNotMatch(value, /[\r\n]/)
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"')
}

test('native installer mode detection requires confirmation except for real upgrades or explicit passive mode', { skip }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qingcode-install-mode-'))
  const registryKey = `Software\\QingCodeInstallerTests\\${path.basename(root)}`
  const uninstallKey = '${UNINSTKEY}'
  const pluginPath = path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'Plugins', 'x86-unicode', 'additional')
  const template = readFileSync(templatePath, 'utf8').replaceAll('\r\n', '\n')
  const configureMode = template.match(/Function QingConfigureInstallMode\n[\s\S]*?FunctionEnd/)[0]
  const cases = [
    { name: 'first install', installed: null, binary: false, expected: '0,0' },
    { name: 'upgrade', installed: '1.2.3-beta.3', binary: true, expected: '1,1' },
    { name: 'same version reinstall', installed: '1.2.3-beta.4', binary: true, expected: '0,0' },
    { name: 'downgrade', installed: '1.2.3-beta.5', binary: true, expected: '0,0' },
    { name: 'stale installation registry', installed: '1.2.3-beta.3', binary: false, expected: '0,0' },
    { name: 'explicit passive install', installed: null, binary: false, passive: 1, expected: '1,0' },
    { name: 'update flag on first install', installed: null, binary: false, update: 1, expected: '0,0' },
    { name: 'explicit updater reinstall', installed: '1.2.3-beta.4', binary: true, update: 1, expected: '1,1' },
  ]
  try {
    for (const [index, scenario] of cases.entries()) {
      const target = path.join(root, `target-${index}`)
      mkdirSync(target)
      if (scenario.binary) writeFileSync(path.join(target, 'qingcode.exe'), 'installed application')
      const resultFile = path.join(root, `result-${index}.txt`)
      const executable = path.join(root, `mode-${index}.exe`)
      const script = path.join(root, `mode-${index}.nsi`)
      writeFileSync(script, `Unicode true
Name "QingCode install mode test"
OutFile "${nsisString(executable)}"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!addplugindir "${nsisString(pluginPath)}"
!define UNINSTKEY "${nsisString(registryKey)}"
!define MAINBINARYNAME "qingcode"
!define VERSION "1.2.3-beta.4"
Var PassiveMode
Var UpdateMode
${configureMode}
Function .onInit
  SetShellVarContext current
  DeleteRegKey HKCU "${uninstallKey}"
  ${scenario.installed ? `WriteRegStr HKCU "${uninstallKey}" "UninstallString" "fixture uninstaller"\n  WriteRegStr HKCU "${uninstallKey}" "DisplayVersion" "${scenario.installed}"` : ''}
  StrCpy $INSTDIR "${nsisString(target)}"
  StrCpy $PassiveMode ${scenario.passive ?? 0}
  StrCpy $UpdateMode ${scenario.update ?? 0}
  Call QingConfigureInstallMode
  FileOpen $0 "${nsisString(resultFile)}" w
  FileWrite $0 "$PassiveMode,$UpdateMode"
  FileClose $0
  DeleteRegKey HKCU "${uninstallKey}"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`)
      execFileSync(makeNsis, ['-INPUTCHARSET', 'UTF8', '-V2', script], { windowsHide: true })
      execFileSync(executable, ['/S'], { windowsHide: true, timeout: 15_000 })
      assert.equal(readFileSync(resultFile, 'utf8'), scenario.expected, scenario.name)
    }
  } finally {
    assert.ok(registryKey.startsWith('Software\\QingCodeInstallerTests\\qingcode-install-mode-'))
    spawnSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:32'], { windowsHide: true, stdio: 'ignore' })
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('qingcode-install-mode-'))
    rmSync(root, { recursive: true, force: true })
  }
})

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
