#requires -version 5.1
<#
.SYNOPSIS
  Watch the installed QingCode process and capture native crash dumps.

.DESCRIPTION
  Attaches CDB (normal heap, no -hd) to C:\Users\<user>\AppData\Local\QingCode\qingcode.exe.
  On 0xc0000374 / 0xc0000409 / 0xc0000005 / critical breakpoint, writes a full dump plus
  stacks under %LOCALAPPDATA%\QingCode\diagnostics\crash-monitor, then waits and re-attaches
  after QingCode is restarted. Detach uses -pd so stopping the monitor does not kill QingCode.

  Start:   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/monitor-qingcode-crash.ps1
  Status:  ... -Action Status
  Stop:    ... -Action Stop
#>
[CmdletBinding()]
param(
  [ValidateSet('Start', 'Run', 'Status', 'Stop')]
  [string]$Action = 'Start',

  [string]$Executable = (Join-Path $env:LOCALAPPDATA 'QingCode\qingcode.exe'),

  [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA 'QingCode\diagnostics\crash-monitor'),

  [int]$AttachProcessId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CdbExecutable = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
$script:ReleaseSymbols = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release'
$script:PowershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:MonitorScriptPath = [IO.Path]::GetFullPath($PSCommandPath)

function ConvertTo-WindowsCommandLineArgument {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  # Start-Process joins ArgumentList arrays with spaces before handing the
  # result to CreateProcess. Quote each value using CommandLineToArgvW's
  # backslash rules so paths with spaces and trailing slashes survive intact.
  $builder = New-Object Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      [void]$builder.Append([char]92, (($backslashes * 2) + 1))
      [void]$builder.Append([char]34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append([char]92, $backslashes)
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append([char]92, ($backslashes * 2))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Join-WindowsCommandLineArguments {
  param([Parameter(Mandatory = $true)][object[]]$Arguments)
  return (($Arguments | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument -Value ([string]$_)
      }) -join ' ')
}

function ConvertTo-CdbPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return $Path.Replace('\', '/')
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-MonitorPaths {
  param([Parameter(Mandatory = $true)][string]$Root)
  $captures = Join-Path $Root 'captures'
  $sessions = Join-Path $Root 'sessions'
  New-Item -ItemType Directory -Force -Path $Root, $captures, $sessions | Out-Null
  return [pscustomobject]@{
    Root = $Root
    Captures = $captures
    Sessions = $sessions
    Status = Join-Path $Root 'status.json'
    Events = Join-Path $Root 'events.jsonl'
    LatestCrash = Join-Path $Root 'LATEST_CRASH.json'
    SupervisorPid = Join-Path $Root 'supervisor.pid'
    StopFlag = Join-Path $Root 'stop.flag'
  }
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Data
  )
  $Data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Write-Event {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Data
  )
  $Data.timestamp = (Get-Date).ToString('o')
  Add-Content -LiteralPath $Path -Value ($Data | ConvertTo-Json -Compress -Depth 8) -Encoding utf8
}

function Get-InstalledQingCodeProcesses {
  param([Parameter(Mandatory = $true)][string]$Executable)
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='qingcode.exe'" -ErrorAction SilentlyContinue)
  return @($processes | Where-Object {
      $_.ExecutablePath -and
      [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $Executable)
    })
}

function Get-SupervisorProcess {
  param([Parameter(Mandatory = $true)]$Paths)
  if (-not (Test-Path -LiteralPath $Paths.SupervisorPid)) {
    return $null
  }
  $raw = Get-Content -LiteralPath $Paths.SupervisorPid -TotalCount 1 -ErrorAction SilentlyContinue
  if ([string]::IsNullOrWhiteSpace([string]$raw)) {
    return $null
  }
  $raw = ([string]$raw).Trim()
  $supervisorId = 0
  if (-not [int]::TryParse($raw, [ref]$supervisorId) -or $supervisorId -le 0) {
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorId" -ErrorAction SilentlyContinue
  if (-not $process) {
    return $null
  }
  if (-not $process.ExecutablePath -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals($process.ExecutablePath, $script:PowershellExe) -or
    [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
    return $null
  }

  $expectedFragments = @(
    (Join-WindowsCommandLineArguments -Arguments @('-File', $script:MonitorScriptPath)),
    (Join-WindowsCommandLineArguments -Arguments @('-Action', 'Run')),
    (Join-WindowsCommandLineArguments -Arguments @('-OutputDirectory', $Paths.Root))
  )
  foreach ($fragment in $expectedFragments) {
    if ($process.CommandLine.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return $null
    }
  }
  return $process
}

function Get-MonitorCdbProcesses {
  param([Parameter(Mandatory = $true)]$Paths)
  $marker = [regex]::Escape($Paths.Sessions)
  return @(Get-CimInstance Win32_Process -Filter "Name='cdb.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -match $marker
    })
}

function Test-PidMonitoredByCdb {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $pattern = '(?i)(?:^|\s)-p\s+{0}(?:\s|$)' -f [regex]::Escape($ProcessId.ToString())
  return [bool]@(Get-CimInstance Win32_Process -Filter "Name='cdb.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -match $pattern
    } | Select-Object -First 1)
}

function Register-LocalDumps {
  param(
    [Parameter(Mandatory = $true)][string]$DumpFolder
  )
  $key = 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\qingcode.exe'
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name DumpFolder -PropertyType ExpandString -Value $DumpFolder -Force | Out-Null
  New-ItemProperty -Path $key -Name DumpType -PropertyType DWord -Value 2 -Force | Out-Null
  New-ItemProperty -Path $key -Name DumpCount -PropertyType DWord -Value 10 -Force | Out-Null
}

function New-CaptureCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$DumpPath
  )
  $cdbDumpPath = ConvertTo-CdbPath $DumpPath
  if ($cdbDumpPath.Contains('"')) {
    throw 'CDB dump paths cannot contain double quote characters.'
  }
  # The whole exception action is quoted by `sxe -c`, so preserve escaped
  # inner quotes around the dump filename for CDB's command parser.
  $quotedDumpPath = '\"{0}\"' -f $cdbDumpPath
  return ".echo ===== QINGCODE CAPTURE $Label =====; .time; .exr -1; .ecxr; r; kv 100; ~* kb 20; .dump /ma /o $quotedDumpPath; .echo ===== DUMP COMMAND RETURNED =====; !heap -triage; !analyze -v; q"
}

function Save-Status {
  param(
    [Parameter(Mandatory = $true)]$Paths,
    [Parameter(Mandatory = $true)][hashtable]$Data
  )
  $Data.updated_at = (Get-Date).ToString('o')
  $Data.supervisor_pid = $PID
  Write-JsonFile -Path $Paths.Status -Data $Data
}

function Show-Status {
  param([Parameter(Mandatory = $true)]$Paths)
  $supervisor = Get-SupervisorProcess -Paths $Paths
  $cdbs = @(Get-MonitorCdbProcesses -Paths $Paths)
  if (Test-Path -LiteralPath $Paths.Status) {
    Get-Content -LiteralPath $Paths.Status -Raw
  } else {
    Write-Output '{"state":"not_started"}'
  }
  Write-Output ''
  if ($supervisor) {
    Write-Output ("supervisor pid={0} started={1}" -f $supervisor.ProcessId, $supervisor.CreationDate)
  } else {
    Write-Output 'supervisor: not running'
  }
  if ($cdbs.Count -eq 0) {
    Write-Output 'cdb: not attached'
  } else {
    $cdbs | ForEach-Object {
      Write-Output ("cdb pid={0} command={1}" -f $_.ProcessId, $_.CommandLine)
    }
  }
  if (Test-Path -LiteralPath $Paths.LatestCrash) {
    Write-Output ''
    Write-Output 'LATEST_CRASH.json:'
    Get-Content -LiteralPath $Paths.LatestCrash -Raw
  }
}

function Stop-Monitor {
  param([Parameter(Mandatory = $true)]$Paths)
  Set-Content -LiteralPath $Paths.StopFlag -Value ((Get-Date).ToString('o')) -Encoding utf8
  $cdbs = @(Get-MonitorCdbProcesses -Paths $Paths)
  foreach ($cdb in $cdbs) {
    Stop-Process -Id $cdb.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $supervisor = Get-SupervisorProcess -Paths $Paths
  if ($supervisor -and [int]$supervisor.ProcessId -ne $PID) {
    Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 400
  if (Test-Path -LiteralPath $Paths.SupervisorPid) {
    Remove-Item -LiteralPath $Paths.SupervisorPid -Force -ErrorAction SilentlyContinue
  }
  $stillSupervisor = Get-SupervisorProcess -Paths $Paths
  $stillCdb = @(Get-MonitorCdbProcesses -Paths $Paths)
  Write-Output ("stopped supervisor={0} leftover_cdb={1}" -f (-not $stillSupervisor), $stillCdb.Count)
}

function Start-MonitorBackground {
  param(
    [Parameter(Mandatory = $true)]$Paths,
    [Parameter(Mandatory = $true)][string]$Executable,
    [int]$AttachProcessId
  )
  $existing = Get-SupervisorProcess -Paths $Paths
  if ($existing) {
    Write-Output ("already running supervisor pid={0}" -f $existing.ProcessId)
    Show-Status -Paths $Paths
    return
  }
  if (Test-Path -LiteralPath $Paths.StopFlag) {
    Remove-Item -LiteralPath $Paths.StopFlag -Force
  }
  $argList = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', $PSCommandPath,
    '-Action', 'Run',
    '-Executable', $Executable,
    '-OutputDirectory', $Paths.Root
  )
  if ($AttachProcessId -gt 0) {
    $argList += @('-AttachProcessId', $AttachProcessId.ToString())
  }
  $arguments = Join-WindowsCommandLineArguments -Arguments $argList
  $started = Start-Process -FilePath $script:PowershellExe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 400
    $supervisor = Get-SupervisorProcess -Paths $Paths
  } while (-not $supervisor -and (Get-Date) -lt $deadline)

  if (-not $supervisor) {
    throw "Supervisor did not start (launcher pid $($started.Id))."
  }
  Write-Output ("started supervisor pid={0}" -f $supervisor.ProcessId)
  Show-Status -Paths $Paths
}

function Test-StopRequested {
  param([Parameter(Mandatory = $true)]$Paths)
  return (Test-Path -LiteralPath $Paths.StopFlag)
}

function Get-SkipProcessId {
  param([Parameter(Mandatory = $true)]$Paths)
  if (-not (Test-Path -LiteralPath $Paths.LatestCrash)) {
    return 0
  }
  try {
    $crash = Get-Content -LiteralPath $Paths.LatestCrash -Raw | ConvertFrom-Json
    $skipId = [int]$crash.pid
    if ($skipId -le 0) {
      return 0
    }
    $stillAlive = Get-CimInstance Win32_Process -Filter "ProcessId=$skipId" -ErrorAction SilentlyContinue
    if ($stillAlive) {
      return $skipId
    }
  } catch {
    return 0
  }
  return 0
}

function Get-TargetProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [int]$PreferredProcessId,
    [int]$SkipProcessId
  )
  $processes = @(Get-InstalledQingCodeProcesses -Executable $Executable | Sort-Object CreationDate)
  if ($SkipProcessId -gt 0) {
    $processes = @($processes | Where-Object { [int]$_.ProcessId -ne $SkipProcessId })
  }
  if ($PreferredProcessId -gt 0) {
    $preferred = @($processes | Where-Object { [int]$_.ProcessId -eq $PreferredProcessId } | Select-Object -First 1)
    if ($preferred.Count -eq 1) {
      return $preferred[0]
    }
  }
  return $processes | Select-Object -First 1
}

function Invoke-CdbSession {
  param(
    [Parameter(Mandatory = $true)]$Paths,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)]$Target
  )

  $targetPid = [int]$Target.ProcessId
  $sessionId = '{0}-pid{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), $targetPid
  $cdbLog = Join-Path $Paths.Sessions "$sessionId-cdb.log"
  $commandFile = Join-Path $Paths.Sessions "$sessionId-commands.txt"
  $heapDump = Join-Path $Paths.Captures "$sessionId-c0000374.dmp"
  $fastFailDump = Join-Path $Paths.Captures "$sessionId-c0000409.dmp"
  $accessViolationDump = Join-Path $Paths.Captures "$sessionId-c0000005.dmp"
  $breakpointDump = Join-Path $Paths.Captures "$sessionId-80000003.dmp"
  $expectedDumps = @($heapDump, $fastFailDump, $accessViolationDump, $breakpointDump)

  $commandLines = @(
    ('sxe -c "{0}" 0xc0000374' -f (New-CaptureCommand -Label '0xc0000374 HEAP_CORRUPTION FIRST_CHANCE' -DumpPath $heapDump)),
    ('sxe -c "{0}" 0xc0000409' -f (New-CaptureCommand -Label '0xc0000409 FAST_FAIL FIRST_CHANCE' -DumpPath $fastFailDump)),
    ('sxd -c2 "{0}" av' -f (New-CaptureCommand -Label '0xc0000005 ACCESS_VIOLATION SECOND_CHANCE' -DumpPath $accessViolationDump)),
    # Heap corruption often reports as int 3 first. Ignore the attach breakpoint
    # via -g; only treat later breakpoints as capture-worthy.
    ('sxe -c "{0}" bpe' -f (New-CaptureCommand -Label '0x80000003 CRITICAL_ERROR_BREAKPOINT FIRST_CHANCE' -DumpPath $breakpointDump)),
    '.echo ===== QINGCODE MONITOR ATTACHED =====',
    'g'
  )
  $commandLines | Set-Content -LiteralPath $commandFile -Encoding ASCII

  $symbolPath = "$script:ReleaseSymbols;srv*$($Paths.Root)\symbols*https://msdl.microsoft.com/download/symbols"
  $cdbArgs = @(
    '-sins', '-g', '-G', '-pd', '-lines',
    '-y', $symbolPath,
    '-logo', $cdbLog,
    '-cf', $commandFile,
    '-p', $targetPid.ToString()
  )

  $exeInfo = Get-Item -LiteralPath $Executable
  Write-Event -Path $Paths.Events -Data @{
    type = 'cdb_attach'
    session_id = $sessionId
    pid = $targetPid
    executable = $Executable
    sha256 = (Get-Sha256Hex -Path $Executable)
    version = $exeInfo.VersionInfo.FileVersion
  }
  Save-Status -Paths $Paths -Data @{
    state = 'attached'
    session_id = $sessionId
    target_pid = $targetPid
    executable = $Executable
    sha256 = (Get-Sha256Hex -Path $Executable)
    version = $exeInfo.VersionInfo.FileVersion
    cdb_log = $cdbLog
    command_file = $commandFile
    expected_dumps = $expectedDumps
  }

  $arguments = Join-WindowsCommandLineArguments -Arguments $cdbArgs
  $cdb = Start-Process -FilePath $script:CdbExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Write-Event -Path $Paths.Events -Data @{
    type = 'cdb_started'
    session_id = $sessionId
    pid = $targetPid
    cdb_pid = $cdb.Id
  }

  while (-not $cdb.HasExited) {
    if (Test-StopRequested -Paths $Paths) {
      Stop-Process -Id $cdb.Id -Force -ErrorAction SilentlyContinue
      break
    }
    Start-Sleep -Seconds 2
    $cdb.Refresh()
  }

  $verified = @($expectedDumps | Where-Object {
      (Test-Path -LiteralPath $_ -PathType Leaf) -and ((Get-Item -LiteralPath $_).Length -gt 0)
    } | ForEach-Object {
      $file = Get-Item -LiteralPath $_
      [ordered]@{
        path = $file.FullName
        length = $file.Length
        lastWriteTime = $file.LastWriteTime.ToString('o')
      }
    })

  $outcome = if (Test-StopRequested -Paths $Paths) {
    'monitor_stopped'
  } elseif ($verified.Count -gt 0) {
    'crash_dump_verified'
  } else {
    'target_exited_without_captured_exception'
  }

  Write-Event -Path $Paths.Events -Data @{
    type = 'cdb_exited'
    session_id = $sessionId
    pid = $targetPid
    cdb_exit_code = $cdb.ExitCode
    outcome = $outcome
    dumps = $verified
    cdb_log = $cdbLog
  }

  if ($verified.Count -gt 0) {
    $crash = [ordered]@{
      captured_at = (Get-Date).ToString('o')
      session_id = $sessionId
      pid = $targetPid
      executable = $Executable
      sha256 = (Get-Sha256Hex -Path $Executable)
      dumps = $verified
      cdb_log = $cdbLog
      command_file = $commandFile
    }
    Write-JsonFile -Path $Paths.LatestCrash -Data $crash
  }

  Save-Status -Paths $Paths -Data @{
    state = $outcome
    session_id = $sessionId
    target_pid = $targetPid
    last_cdb_exit_code = $cdb.ExitCode
    dumps = $verified
    cdb_log = $cdbLog
  }

  return $outcome
}

function Invoke-SupervisorLoop {
  param(
    [Parameter(Mandatory = $true)]$Paths,
    [Parameter(Mandatory = $true)][string]$Executable,
    [int]$AttachProcessId
  )

  if (-not (Test-Path -LiteralPath $script:CdbExecutable -PathType Leaf)) {
    throw "CDB not found: $script:CdbExecutable"
  }
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw "QingCode executable not found: $Executable"
  }

  Register-LocalDumps -DumpFolder $Paths.Captures
  Set-Content -LiteralPath $Paths.SupervisorPid -Value $PID.ToString() -Encoding ascii
  Write-Event -Path $Paths.Events -Data @{
    type = 'monitor_started'
    supervisor_pid = $PID
    executable = $Executable
    output = $Paths.Root
  }
  Save-Status -Paths $Paths -Data @{
    state = 'waiting_for_process'
    executable = $Executable
  }

  $preferredPid = $AttachProcessId
  try {
    while (-not (Test-StopRequested -Paths $Paths)) {
      $skipPid = Get-SkipProcessId -Paths $Paths
      $target = Get-TargetProcess -Executable $Executable -PreferredProcessId $preferredPid -SkipProcessId $skipPid
      $preferredPid = 0
      if (-not $target) {
        $waitState = @{
          state = 'waiting_for_process'
          executable = $Executable
        }
        if ($skipPid -gt 0) {
          $waitState.state = 'waiting_for_new_process_after_crash'
          $waitState.skip_pid = $skipPid
        }
        Save-Status -Paths $Paths -Data $waitState
        Start-Sleep -Seconds 2
        continue
      }

      $targetPid = [int]$target.ProcessId
      if (Test-PidMonitoredByCdb -ProcessId $targetPid) {
        Save-Status -Paths $Paths -Data @{
          state = 'already_monitored_by_other_cdb'
          target_pid = $targetPid
          executable = $Executable
        }
        Start-Sleep -Seconds 5
        continue
      }

      [void](Invoke-CdbSession -Paths $Paths -Executable $Executable -Target $target)
    }
  } finally {
    Write-Event -Path $Paths.Events -Data @{
      type = 'monitor_stopped'
      supervisor_pid = $PID
    }
    if (Test-Path -LiteralPath $Paths.SupervisorPid) {
      $current = (Get-Content -LiteralPath $Paths.SupervisorPid -TotalCount 1).Trim()
      if ($current -eq $PID.ToString()) {
        Remove-Item -LiteralPath $Paths.SupervisorPid -Force -ErrorAction SilentlyContinue
      }
    }
    if (Test-Path -LiteralPath $Paths.StopFlag) {
      Remove-Item -LiteralPath $Paths.StopFlag -Force -ErrorAction SilentlyContinue
    }
    Save-Status -Paths $Paths -Data @{
      state = 'stopped'
      executable = $Executable
    }
  }
}

$resolvedExecutable = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Executable))
$resolvedOutput = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($OutputDirectory))
$paths = Get-MonitorPaths -Root $resolvedOutput

switch ($Action) {
  'Status' { Show-Status -Paths $paths }
  'Stop' { Stop-Monitor -Paths $paths }
  'Run' { Invoke-SupervisorLoop -Paths $paths -Executable $resolvedExecutable -AttachProcessId $AttachProcessId }
  default { Start-MonitorBackground -Paths $paths -Executable $resolvedExecutable -AttachProcessId $AttachProcessId }
}
