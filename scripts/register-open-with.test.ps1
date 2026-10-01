# Run the real registration script against an in-memory registry. Never bind the
# fake provider to HKCU/HKCR, so a regression cannot damage the host associations.
$ErrorActionPreference = 'Stop'
$global:associationTestKeys = @{}
$global:associationTestWrites = [System.Collections.Generic.List[string]]::new()
$classes = 'HKCU:\Software\Classes'
$progId = 'QingCode.Document'
$app = "$classes\Applications\QingCode.exe"

class MemoryRegistryKey {
  [hashtable]$Values = @{}
  [string[]] GetValueNames() { return [string[]]@($this.Values.Keys) }
  [object] GetValue([string]$Name) { return $this.Values[$Name] }
}

function Normalize-Key([string]$Path) {
  if (-not $Path.StartsWith('HKCU:\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected registry path: $Path"
  }
  return $Path.TrimEnd('\').ToLowerInvariant()
}

function Seed-Key([string]$Path, [hashtable]$Values = @{}) {
  $normalized = Normalize-Key $Path
  $key = [MemoryRegistryKey]::new()
  $key.Values = $Values.Clone()
  $global:associationTestKeys[$normalized] = $key
  return $key
}

function Test-Path {
  param([string]$LiteralPath, [string]$PathType)
  if ($LiteralPath.StartsWith('HKCU:\', [StringComparison]::OrdinalIgnoreCase)) {
    return $global:associationTestKeys.ContainsKey((Normalize-Key $LiteralPath))
  }
  if ($PathType -eq 'Leaf') { return [System.IO.File]::Exists($LiteralPath) }
  throw "Unexpected filesystem lookup: $LiteralPath"
}

function New-Item {
  param([string]$Path, [switch]$Force)
  $normalized = Normalize-Key $Path
  $global:associationTestWrites.Add("create:$normalized")
  if ($global:associationTestKeys.ContainsKey($normalized) -and -not $Force) {
    throw "Attempted to recreate existing registry key: $Path"
  }
  # Model New-Item -Force's destructive semantics. Preservation assertions below
  # fail if production ever goes back to recreating a key with -Force.
  $null = Seed-Key $Path
}

function Get-Item {
  param([string]$LiteralPath)
  $normalized = Normalize-Key $LiteralPath
  if (-not $global:associationTestKeys.ContainsKey($normalized)) { throw "Missing key: $LiteralPath" }
  return $global:associationTestKeys[$normalized]
}

function Set-ItemProperty {
  param([string]$LiteralPath, [string]$Name, [object]$Value, [string]$Type)
  if ($Name -eq '(default)') { $Name = '' }
  $key = Get-Item -LiteralPath $LiteralPath
  $key.Values[$Name] = $Value
  $global:associationTestWrites.Add("set:$(Normalize-Key $LiteralPath):$Name")
}

function New-ItemProperty {
  param([string]$LiteralPath, [string]$Name, [string]$PropertyType, [object]$Value, [switch]$Force)
  Set-ItemProperty -LiteralPath $LiteralPath -Name $Name -Value $Value
}

function Remove-ItemProperty {
  param([string]$LiteralPath, [string]$Name, [switch]$Force)
  if ($Name -eq '(default)') { $Name = '' }
  (Get-Item -LiteralPath $LiteralPath).Values.Remove($Name)
  $global:associationTestWrites.Add("delete-value:$(Normalize-Key $LiteralPath):$Name")
}

function Remove-Item { throw 'Registration must never delete an entire association key.' }

Add-Type -TypeDefinition @'
namespace QingCodeNative {
  public static class Shell {
    public static int Notifications;
    public static void SHChangeNotify(int id, uint flags, System.IntPtr a, System.IntPtr b) {
      Notifications++;
    }
  }
}
'@

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw "$Message (actual: $Actual; expected: $Expected)" }
}

$null = Seed-Key "$classes\.txt" @{ '' = 'txtfilelegacy'; 'Content Type' = 'text/plain' }
$null = Seed-Key "$classes\.txt\OpenWithProgids" @{ 'Notepad.Handler' = ''; 'Other.Editor' = '' }
$null = Seed-Key "$classes\.bat" @{ '' = 'batfile'; 'Preserve' = 'batch data' }
$null = Seed-Key "$classes\.bat\OpenWithProgids" @{ $progId = ''; 'batfile' = '' }
$null = Seed-Key "$classes\.cmd" @{ '' = '' }
$null = Seed-Key "$classes\.cmd\OpenWithProgids" @{ $progId = ''; 'cmdfile' = '' }
$null = Seed-Key "$classes\.log" @{ '' = '' }
$null = Seed-Key "$classes\.log\OpenWithProgids" @{ 'Other.Editor' = '' }
$null = Seed-Key "$classes\.md" @{ '' = $progId }
$null = Seed-Key "$classes\.md\OpenWithProgids" @{ $progId = '' }
$null = Seed-Key "$classes\$progId" @{ 'Preserve' = 'owned metadata' }
$null = Seed-Key "$app\SupportedTypes" @{ '.bat' = ''; '.cmd' = ''; '.custom' = '' }
$choicePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.txt\UserChoice'
$null = Seed-Key $choicePath @{ 'ProgId' = 'Notepad.Handler'; 'Hash' = 'keep this hash' }
$registrationScript = Join-Path $PSScriptRoot 'register-open-with.ps1'
$executable = Join-Path $PSHOME 'pwsh.exe'

# First registration and a repeated registration must preserve other handlers,
# default values, content types, and third-party supported types.
for ($iteration = 0; $iteration -lt 2; $iteration++) {
  & $registrationScript -ExePath $executable
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt").GetValue('') 'txtfilelegacy' 'Notepad default changed'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt").GetValue('Content Type') 'text/plain' 'Text metadata lost'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").Values.ContainsKey('Notepad.Handler') $true 'Notepad recommendation lost'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").Values.ContainsKey('Other.Editor') $true 'Other editor lost'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").Values.ContainsKey($progId) $true 'QingCode not registered'
  Assert-Equal (Get-Item -LiteralPath "$classes\.bat").GetValue('') 'batfile' 'Batch execution default changed'
  Assert-Equal (Get-Item -LiteralPath "$classes\.bat").GetValue('Preserve') 'batch data' 'Batch metadata lost'
  Assert-Equal (Get-Item -LiteralPath "$classes\.bat\OpenWithProgids").Values.ContainsKey($progId) $false 'Legacy batch entry not removed'
  Assert-Equal (Get-Item -LiteralPath "$classes\.cmd").Values.ContainsKey('') $false 'Legacy blank override not removed'
  Assert-Equal (Get-Item -LiteralPath "$classes\.log").Values.ContainsKey('') $true 'Unowned blank default changed'
  Assert-Equal (Get-Item -LiteralPath "$classes\.md").GetValue('') $progId 'Explicit QingCode default changed'
  Assert-Equal (Get-Item -LiteralPath "$app\SupportedTypes").Values.ContainsKey('.bat') $false 'Batch recommended through SupportedTypes'
  Assert-Equal (Get-Item -LiteralPath "$app\SupportedTypes").Values.ContainsKey('.cmd') $false 'CMD recommended through SupportedTypes'
  Assert-Equal (Get-Item -LiteralPath "$app\SupportedTypes").Values.ContainsKey('.custom') $true 'Custom supported type lost'
  Assert-Equal (Get-Item -LiteralPath "$classes\$progId").GetValue('Preserve') 'owned metadata' 'ProgID metadata lost'
  Assert-Equal (Get-Item -LiteralPath $choicePath).GetValue('ProgId') 'Notepad.Handler' 'UserChoice overwritten'
  Assert-Equal (Get-Item -LiteralPath $choicePath).GetValue('Hash') 'keep this hash' 'UserChoice hash overwritten'
}

$command = (Get-Item -LiteralPath "$classes\$progId\shell\open\command").GetValue('')
for ($iteration = 0; $iteration -lt 2; $iteration++) {
  & $registrationScript -Unregister
  Assert-Equal (Get-Item -LiteralPath "$classes\$progId\shell\open\command").GetValue('') $command 'Default handler command orphaned'
  Assert-Equal (Get-Item -LiteralPath "$app\shell\open\command").GetValue('') $command 'Application default command orphaned'
  Assert-Equal (Get-Item -LiteralPath "$classes\$progId").Values.ContainsKey('NoOpenWith') $true 'ProgID remains recommended'
  Assert-Equal (Get-Item -LiteralPath $app).Values.ContainsKey('NoOpenWith') $true 'Application remains recommended'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").Values.ContainsKey($progId) $false 'QingCode recommendation not removed'
  Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").Values.ContainsKey('Notepad.Handler') $true 'Unregister removed Notepad'
}

& $registrationScript -ExePath $executable
Assert-Equal (Get-Item -LiteralPath $app).Values.ContainsKey('NoOpenWith') $false 'Re-register did not unhide application'
Assert-Equal (Get-Item -LiteralPath "$classes\$progId").Values.ContainsKey('NoOpenWith') $false 'Re-register did not unhide ProgID'
Assert-Equal (Get-Item -LiteralPath "$classes\.txt\OpenWithProgids").Values.ContainsKey($progId) $true 'Re-register did not restore recommendation'
Assert-Equal ([QingCodeNative.Shell]::Notifications) 5 'Shell was not notified of each change'
if ($global:associationTestWrites | Where-Object { $_ -match 'userchoice|hklm|hkey_classes_root' }) {
  throw 'Registration wrote outside its owned per-user association scope.'
}
Write-Host 'PASS: registration, repeat registration, unregister, and re-register preserve existing associations.'
