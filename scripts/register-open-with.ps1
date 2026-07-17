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

function Notify-Shell {
  Add-Type -Namespace QingCodeNative -Name Shell -MemberDefinition @'
    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);
'@ -ErrorAction SilentlyContinue
  if ([type]::GetType('QingCodeNative.Shell')) {
    [QingCodeNative.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}

if ($Unregister) {
  $classes = 'HKCU:\Software\Classes'
  Remove-Item -LiteralPath (Join-Path $classes $progId) -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $classes "Applications\$appKey") -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($ext in $extensions) {
    $ow = Join-Path $classes ".$ext\OpenWithProgids"
    if (Test-Path -LiteralPath $ow) {
      Remove-ItemProperty -LiteralPath $ow -Name $progId -Force -ErrorAction SilentlyContinue
    }
  }
  Notify-Shell
  Write-Host "OK Unregistered QingCode from Open with ($($extensions.Count) extensions)." -ForegroundColor Green
  return
}

if (-not $ExePath) { $ExePath = $defaultExe }
$ExePath = [System.IO.Path]::GetFullPath($ExePath)
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
  throw "Executable not found: $ExePath`nBuild with: pnpm package:exe"
}

$command = "`"$ExePath`" `"%1`""
$icon = "$ExePath,0"
$classesRoot = 'HKCU:\Software\Classes'

New-Item -Path (Join-Path $classesRoot $progId) -Force | Out-Null
Set-ItemProperty -LiteralPath (Join-Path $classesRoot $progId) -Name '(default)' -Value $friendly
New-Item -Path (Join-Path $classesRoot "$progId\DefaultIcon") -Force | Out-Null
Set-ItemProperty -LiteralPath (Join-Path $classesRoot "$progId\DefaultIcon") -Name '(default)' -Value $icon
New-Item -Path (Join-Path $classesRoot "$progId\shell\open\command") -Force | Out-Null
Set-ItemProperty -LiteralPath (Join-Path $classesRoot "$progId\shell\open\command") -Name '(default)' -Value $command

$appRoot = Join-Path $classesRoot "Applications\$appKey"
New-Item -Path $appRoot -Force | Out-Null
Set-ItemProperty -LiteralPath $appRoot -Name 'FriendlyAppName' -Value $friendly
New-Item -Path (Join-Path $appRoot 'DefaultIcon') -Force | Out-Null
Set-ItemProperty -LiteralPath (Join-Path $appRoot 'DefaultIcon') -Name '(default)' -Value $icon
New-Item -Path (Join-Path $appRoot 'shell\open\command') -Force | Out-Null
Set-ItemProperty -LiteralPath (Join-Path $appRoot 'shell\open\command') -Name '(default)' -Value $command
New-Item -Path (Join-Path $appRoot 'SupportedTypes') -Force | Out-Null

foreach ($ext in $extensions) {
  $dotted = ".$ext"
  Set-ItemProperty -LiteralPath (Join-Path $appRoot 'SupportedTypes') -Name $dotted -Value ''
  $extKey = Join-Path $classesRoot $dotted
  New-Item -Path $extKey -Force | Out-Null
  $ow = Join-Path $extKey 'OpenWithProgids'
  New-Item -Path $ow -Force | Out-Null
  New-ItemProperty -LiteralPath $ow -Name $progId -PropertyType String -Value '' -Force | Out-Null
}

Notify-Shell
Write-Host "OK Registered Open with QingCode" -ForegroundColor Green
Write-Host "  exe: $ExePath"
Write-Host "  extensions: $($extensions.Count)"
Write-Host ""
Write-Host "Verify: right-click a .ts/.md/.json file → Open with → QingCode" -ForegroundColor DarkGray
Write-Host "Unregister: pwsh -File ./scripts/register-open-with.ps1 -Unregister" -ForegroundColor DarkGray
