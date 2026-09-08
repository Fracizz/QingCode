# Run with: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/monitor-qingcode-crash.test.ps1
# Import functions only: never launch the monitor or change WER registration.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$parseErrors = $null
$source = Join-Path $PSScriptRoot 'monitor-qingcode-crash.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true) |
  ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
$script:PowershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:MonitorScriptPath = $source
$script:CdbExecutable = 'C:\debuggers\cdb.exe'
$script:ReleaseSymbols = 'C:\symbols'
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

& {
  $paths = [pscustomobject]@{ Root = 'C:\captures\monitor'; SupervisorPid = 'unused' }
  function Test-Path { param($LiteralPath) return $true }
  function Get-Content { param($LiteralPath, $TotalCount, $ErrorAction) return '1234' }
  function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $fakeProcess }
  $fakeProcess = [pscustomobject]@{
    ProcessId = 1234; ExecutablePath = $script:PowershellExe; CommandLine = ''
  }
  foreach ($root in @($paths.Root, ($paths.Root + '-other'), ($paths.Root + '\nested'))) {
    $fakeProcess.CommandLine = Join-WindowsCommandLineArguments @(
      $script:PowershellExe, '-NoProfile', '-File', $source, '-Action', 'Run',
      '-Executable', 'C:\Program Files\QingCode\qingcode.exe', '-OutputDirectory', $root)
    Assert-True (($null -ne (Get-SupervisorProcess $paths)) -eq ($root -eq $paths.Root)) "Incorrect identity for $root"
  }
  $fakeProcess.CommandLine = Join-WindowsCommandLineArguments @(
    $script:PowershellExe, '-Command', "Write-Output '-File $source -Action Run -OutputDirectory $($paths.Root)'")
  Assert-True ($null -eq (Get-SupervisorProcess $paths)) 'Accepted command text as a script invocation'
  $fakeProcess.CommandLine = Join-WindowsCommandLineArguments @(
    $script:PowershellExe, '-File', $source, '-Action', 'Run', '-OutputDirectory', $paths.Root,
    '-OutputDirectory', 'C:\other')
  Assert-True ($null -eq (Get-SupervisorProcess $paths)) 'Accepted duplicate parameters'
  $fakeProcess.CommandLine = $null
  Assert-True ($null -eq (Get-SupervisorProcess $paths)) 'Accepted missing command line'

  $values = @('C:\path with spaces\', 'embedded"quote', '', 'plain', 'C:\trailing\')
  $roundTrip = @(Split-WindowsCommandLine (Join-WindowsCommandLineArguments (@('program.exe') + $values)))
  Assert-True ($roundTrip.Count -eq $values.Count + 1) 'Argument count changed'
  for ($index = 0; $index -lt $values.Count; $index++) {
    Assert-True ($roundTrip[$index + 1] -ceq $values[$index]) "Argument $index changed"
  }
  $paths.Root = 'C:\captures with spaces\monitor'
  $fakeProcess.CommandLine = Join-WindowsCommandLineArguments @(
    $script:PowershellExe, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-File', $source, '-Action', 'Run', '-OutputDirectory', $paths.Root)
  Assert-True ($null -ne (Get-SupervisorProcess $paths)) 'Rejected the background launcher arguments'

  $paths | Add-Member NoteProperty Sessions 'C:\captures\monitor\sessions'
  $fakeProcess.ExecutablePath = $script:CdbExecutable
  foreach ($directory in @($paths.Sessions, ($paths.Sessions + '-other'))) {
    $fakeProcess.CommandLine = Join-WindowsCommandLineArguments @(
      $script:CdbExecutable, '-cf', (Join-Path $directory 'commands.txt'), '-p', '1234')
    Assert-True ((@(Get-MonitorCdbProcesses $paths).Count -eq 1) -eq ($directory -eq $paths.Sessions)) 'Incorrect CDB identity'
  }
}
Write-Output 'PASS: argument round trips and exact supervisor/CDB identity'

& {
  $paths = [pscustomobject]@{ StopFlag = 'stop.flag'; SupervisorPid = 'supervisor.pid' }
  $original = [pscustomobject]@{ ProcessId = 1234; CreationDate = [datetime]'2026-01-01' }
  function Set-Content { param($LiteralPath, $Value, $Encoding) }
  function Start-Sleep { param($Milliseconds) }
  function Test-Path { param($LiteralPath) return $true }
  function Get-Content { param($LiteralPath, $TotalCount) return '1234' }
  function Remove-Item { param($LiteralPath, [switch]$Force) $script:removedPid = $true }
  function Stop-Process { param($Id, [switch]$Force, $ErrorAction) }
  function Get-SupervisorProcess { param($Paths) if ($script:lookupCount++ -eq 0) { return $original } }
  function Get-MonitorCdbProcesses { param($Paths) }
  function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($mode -eq 'query_failure') { throw 'query failed' }
    if ($mode -eq 'still_running') { return $original }
    if ($mode -eq 'pid_reused') {
      return [pscustomobject]@{ ProcessId = 1234; CreationDate = [datetime]'2026-01-02' }
    }
  }
  foreach ($mode in @('still_running', 'query_failure', 'exited', 'pid_reused')) {
    $script:lookupCount = 0
    $script:removedPid = $false
    $failed = $false
    try { $output = @(Stop-Monitor $paths) } catch { $failed = $true }
    $shouldFail = $mode -in @('still_running', 'query_failure')
    Assert-True ($failed -eq $shouldFail) "Incorrect stop outcome: $mode"
    Assert-True ($script:removedPid -eq (-not $shouldFail)) "Incorrect PID cleanup: $mode"
    if (-not $shouldFail) {
      Assert-True ($output -contains 'stopped supervisor=True leftover_cdb=0') 'Missing stop confirmation'
    }
  }
}
Write-Output 'PASS: failed stop/query preserves PID; confirmed exit and reused PID handled'

& {
  # Unicode directory plus spaces; ASCII source also works under Windows PowerShell 5.1.
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $testRoot = Join-Path $tempParent ('qingcode-monitor-test-' + [guid]::NewGuid().ToString('N'))
  $unicodeRoot = Join-Path $testRoot (([string][char]0x5F20) + [char]0x4E09 + ' crash monitor')
  try {
    $paths = Get-MonitorPaths $unicodeRoot
    function Write-Event { param($Path, $Data) }
    function Save-Status { param($Paths, $Data) }
    function Get-Sha256Hex { param($Path) return 'test' }
    function Test-StopRequested { param($Paths) return $false }
    function Start-Process {
      param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
      Assert-True ($WorkingDirectory -ceq $paths.Captures) 'CDB must run in the Unicode capture directory'
      $arguments = @(Split-WindowsCommandLine ("cdb.exe " + $ArgumentList))
      $cfIndex = [Array]::IndexOf($arguments, '-cf')
      $commandFile = $arguments[$cfIndex + 1]
      Assert-True (Test-Path -LiteralPath $commandFile) 'Command file argument was corrupted'
      $commands = Get-Content -LiteralPath $commandFile -Raw
      Assert-True ($commands -notmatch '[^\x00-\x7F]') 'Command file contains non-ASCII text'
      $dumps = [regex]::Matches($commands, '\.dump /ma /o ([^;]+);')
      Assert-True ($dumps.Count -eq 4) 'Missing exception dump commands'
      foreach ($dump in $dumps) {
        $filename = $dump.Groups[1].Value
        Assert-True ($filename -match '\A[0-9-]+-pid1234-[a-f0-9]+\.dmp\z') 'Dump path is not a generated relative basename'
        # Simulate CDB resolving its relative filename using its working directory.
        Set-Content -LiteralPath (Join-Path $WorkingDirectory $filename) -Value 'test dump'
      }
      return [pscustomobject]@{ Id = 5678; HasExited = $true; ExitCode = 0 }
    }
    $outcome = Invoke-CdbSession $paths $script:PowershellExe ([pscustomobject]@{ ProcessId = 1234 })
    Assert-True ($outcome -eq 'crash_dump_verified') 'Captures were not found at the expected absolute paths'
    $crash = Get-Content -LiteralPath $paths.LatestCrash -Raw | ConvertFrom-Json
    Assert-True ($crash.dumps.Count -eq 4) 'Missing capture records'
  } finally {
    if ([IO.Path]::GetDirectoryName($testRoot) -ne $tempParent -or
      [IO.Path]::GetFileName($testRoot) -notmatch '\Aqingcode-monitor-test-[a-f0-9]{32}\z') {
      throw 'Unexpected test cleanup path'
    }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  }
}
Write-Output 'PASS: Unicode/spaced CDB working directory, command file and capture verification (mock CDB)'
