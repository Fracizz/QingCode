<#
.SYNOPSIS
  Register or unregister QingCode in Windows Explorer "Open with" for text/code files.

.DESCRIPTION
  Writes HKCU ProgId + OpenWithProgids (no admin). Points at the portable exe from
  package:exe (release\QingCode.exe) or an explicit -ExePath.

.EXAMPLE
  pnpm exec pwsh -File ./scripts/register-open-with.ps1
  pnpm exec pwsh -File ./scripts/register-open-with.ps1 -Unregister
  pnpm exec pwsh -File ./scripts/register-open-with.ps1 -ExePath D:\tools\QingCode.exe
#>
[CmdletBinding()]
param(
  [string]$ExePath,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultExe = Join-Path $projectRoot 'release\QingCode.exe'
$progId = 'QingCode.Document'
$appKey = 'QingCode.exe'
$friendly = 'QingCode'

$extensions = @(
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'py', 'rs', 'toml', 'yaml', 'yml', 'ini',
  'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'go', 'java', 'c', 'h', 'cpp',
  'cc', 'cxx', 'hpp', 'cs', 'kt', 'kts', 'swift', 'rb', 'php', 'lua', 'sql', 'graphql', 'gql',
  'vue', 'svelte', 'r', 'dart', 'scala', 'groovy', 'gradle', 'properties', 'diff', 'patch',
  'log', 'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'makefile', 'cmake',
  'tex', 'rst', 'adoc', 'csv', 'tsv'
)
$editorOnlyExtensions = @('bat', 'cmd')
$openWithExtensions = @($extensions | Where-Object { $_ -notin $editorOnlyExtensions })
$classesRoot = 'HKCU:\Software\Classes'
$versionName = 'QingCodeRegistrationVersion'
$existingApp = Join-Path $classesRoot "Applications\$appKey"
$repairLegacyDefaults = $true
if (Test-Path -LiteralPath $existingApp) {
  $existingVersion = (Get-Item -LiteralPath $existingApp).GetValue($versionName)
  $repairLegacyDefaults = -not ($existingVersion -is [int] -and $existingVersion -ge 2)
}

function Ensure-RegistryKey([string]$Path) {
  # New-Item -Force clears an existing registry key's values, including its
  # default handler. Only create keys that are actually missing.
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -Path $Path | Out-Null
  }
}

function Remove-RegistryValue([string]$Path, [string]$Name) {
  if ((Test-Path -LiteralPath $Path) -and
      (Get-Item -LiteralPath $Path).GetValueNames() -contains $Name) {
    Remove-ItemProperty -LiteralPath $Path -Name $Name -Force
  }
}

function Clear-LegacyExtensionEntries([bool]$RemoveAll) {
  foreach ($ext in $extensions) {
    $extKey = Join-Path $classesRoot ".$ext"
    $ow = Join-Path $extKey 'OpenWithProgids'
    if (-not (Test-Path -LiteralPath $ow)) { continue }
    $owned = (Get-Item -LiteralPath $ow).GetValueNames() -contains $progId
    if ($owned -and $repairLegacyDefaults) {
      $key = Get-Item -LiteralPath $extKey
      if ($key.GetValueNames() -contains '' -and $key.GetValue('') -is [string] -and $key.GetValue('') -eq '') {
        # Drop only our legacy blank override, allowing Windows to inherit the
        # machine association. Preserve nonempty/custom defaults and UserChoice.
        Remove-ItemProperty -LiteralPath $extKey -Name '(default)' -Force
      }
    }
    if ($RemoveAll -or $ext -in $editorOnlyExtensions) {
      Remove-RegistryValue -Path $ow -Name $progId
    }
  }
}

function Notify-Shell {
  if (-not ('QingCodeNative.Shell' -as [type])) {
    Add-Type -Namespace QingCodeNative -Name Shell -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);
'@
  }
  [QingCodeNative.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

if ($Unregister) {
  # Keep launch commands valid for users who explicitly selected QingCode as
  # their default. Hiding the entry must not leave an orphaned UserChoice.
  foreach ($ownedKey in @($progId, "Applications\$appKey")) {
    $ownedPath = Join-Path $classesRoot $ownedKey
    if (Test-Path -LiteralPath $ownedPath) {
      Set-ItemProperty -LiteralPath $ownedPath -Name 'NoOpenWith' -Value ''
    }
  }
  Clear-LegacyExtensionEntries -RemoveAll $true
  Notify-Shell
  Write-Host "OK Unregistered QingCode from Open with (existing default choices preserved)." -ForegroundColor Green
  return
}

if (-not $ExePath) { $ExePath = $defaultExe }
$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
  throw "Executable not found: $ExePath`nBuild with: pnpm package:exe"
}

$command = "`"$ExePath`" `"%1`""
$icon = "$ExePath,0"

Ensure-RegistryKey -Path (Join-Path $classesRoot $progId)
Set-ItemProperty -LiteralPath (Join-Path $classesRoot $progId) -Name '(default)' -Value $friendly
Remove-RegistryValue -Path (Join-Path $classesRoot $progId) -Name 'NoOpenWith'
Ensure-RegistryKey -Path (Join-Path $classesRoot "$progId\DefaultIcon")
Set-ItemProperty -LiteralPath (Join-Path $classesRoot "$progId\DefaultIcon") -Name '(default)' -Value $icon
Ensure-RegistryKey -Path (Join-Path $classesRoot "$progId\shell\open\command")
Set-ItemProperty -LiteralPath (Join-Path $classesRoot "$progId\shell\open\command") -Name '(default)' -Value $command

$appRoot = Join-Path $classesRoot "Applications\$appKey"
Ensure-RegistryKey -Path $appRoot
Set-ItemProperty -LiteralPath $appRoot -Name 'FriendlyAppName' -Value $friendly
Remove-RegistryValue -Path $appRoot -Name 'NoOpenWith'
Ensure-RegistryKey -Path (Join-Path $appRoot 'DefaultIcon')
Set-ItemProperty -LiteralPath (Join-Path $appRoot 'DefaultIcon') -Name '(default)' -Value $icon
Ensure-RegistryKey -Path (Join-Path $appRoot 'shell\open\command')
Set-ItemProperty -LiteralPath (Join-Path $appRoot 'shell\open\command') -Name '(default)' -Value $command
Ensure-RegistryKey -Path (Join-Path $appRoot 'SupportedTypes')
Clear-LegacyExtensionEntries -RemoveAll $false
foreach ($ext in $editorOnlyExtensions) {
  Remove-RegistryValue -Path (Join-Path $appRoot 'SupportedTypes') -Name ".$ext"
}

foreach ($ext in $openWithExtensions) {
  $dotted = ".$ext"
  Set-ItemProperty -LiteralPath (Join-Path $appRoot 'SupportedTypes') -Name $dotted -Value ''
  $extKey = Join-Path $classesRoot $dotted
  Ensure-RegistryKey -Path $extKey
  $ow = Join-Path $extKey 'OpenWithProgids'
  Ensure-RegistryKey -Path $ow
  New-ItemProperty -LiteralPath $ow -Name $progId -PropertyType String -Value '' -Force | Out-Null
}
Set-ItemProperty -LiteralPath $appRoot -Name $versionName -Type DWord -Value 2

Notify-Shell
Write-Host "OK Registered Open with QingCode" -ForegroundColor Green
Write-Host "  exe: $ExePath"
Write-Host "  extensions: $($openWithExtensions.Count) (batch execution associations excluded)"
Write-Host ""
Write-Host "Verify: right-click a .ts/.md/.json file → Open with → QingCode" -ForegroundColor DarkGray
Write-Host "Unregister: pwsh -File ./scripts/register-open-with.ps1 -Unregister" -ForegroundColor DarkGray
