[CmdletBinding()]
param(
  [string]$Executable = (Join-Path $env:LOCALAPPDATA 'QingCode\qingcode.exe'),
  [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA 'com.qingcode.app\diagnostics\crash-monitor'),
  [ValidateRange(1, 720)]
  [int]$DurationHours = 168,
  [ValidateRange(1, 60)]
  [int]$SampleSeconds = 10,
  [switch]$LaunchIfMissing
)

$ErrorActionPreference = 'Stop'

function Write-JsonLine {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [hashtable]$Data
  )

  $Data.timestamp = (Get-Date).ToString('o')
  Add-Content -LiteralPath $Path -Value ($Data | ConvertTo-Json -Compress -Depth 8) -Encoding utf8
}

function Get-ProcessPathSafely {
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)

  try {
    return $Process.Path
  } catch {
    return $null
  }
}

function Get-ExitCodeSafely {
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)

  try {
    return $Process.ExitCode
  } catch {
    return $null
  }
}

function Get-ParentIdSafely {
  param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)

  try {
    return $Process.Parent.Id
  } catch {
    return $null
  }
}

function Get-QingCodeEvents {
  param([Parameter(Mandatory)][datetime]$Since)

  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $Since } -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProviderName -in @('Application Error', 'Windows Error Reporting', 'Application Hang', '.NET Runtime') -and
      $_.Message -match '(?i)(^|\\|\s)qingcode\.exe|msedgewebview2\.exe'
    } |
    Select-Object -First 50 TimeCreated, Id, ProviderName, LevelDisplayName, Message
}

$resolvedExecutable = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Executable))
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) {
  throw "QingCode executable not found: $resolvedExecutable"
}

$resolvedOutput = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($OutputDirectory))
$dumpDirectory = Join-Path $resolvedOutput 'dumps'
New-Item -ItemType Directory -Path $dumpDirectory -Force | Out-Null

$eventsPath = Join-Path $resolvedOutput 'events.jsonl'
$samplesPath = Join-Path $resolvedOutput 'process-samples.csv'
$statusPath = Join-Path $resolvedOutput 'status.json'
$metadataPath = Join-Path $resolvedOutput 'metadata.json'

$dumpKey = 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\qingcode.exe'
New-Item -Path $dumpKey -Force | Out-Null
New-ItemProperty -Path $dumpKey -Name DumpFolder -PropertyType ExpandString -Value $dumpDirectory -Force | Out-Null
New-ItemProperty -Path $dumpKey -Name DumpType -PropertyType DWord -Value 2 -Force | Out-Null
New-ItemProperty -Path $dumpKey -Name DumpCount -PropertyType DWord -Value 10 -Force | Out-Null

$startedAt = Get-Date
$deadline = $startedAt.AddHours($DurationHours)
$version = (Get-Item -LiteralPath $resolvedExecutable).VersionInfo.ProductVersion
$metadata = [ordered]@{
  monitor_pid = $PID
  monitor_started = $startedAt.ToString('o')
  monitor_deadline = $deadline.ToString('o')
  executable = $resolvedExecutable
  product_version = $version
  sample_seconds = $SampleSeconds
  dump_directory = $dumpDirectory
  computer = $env:COMPUTERNAME
  user = $env:USERNAME
}
$metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataPath -Encoding utf8

Write-JsonLine -Path $eventsPath -Data @{
  type = 'monitor_started'
  monitor_pid = $PID
  executable = $resolvedExecutable
  product_version = $version
  deadline = $deadline.ToString('o')
}

$targetPath = $resolvedExecutable.ToLowerInvariant()
$active = @{}
$launched = $false
$lastStateByPid = @{}
$csvInitialized = Test-Path -LiteralPath $samplesPath

if ($LaunchIfMissing) {
  $matching = @(Get-Process -Name 'qingcode' -ErrorAction SilentlyContinue | Where-Object {
      $path = Get-ProcessPathSafely -Process $_
      $path -and $path.ToLowerInvariant() -eq $targetPath
    })
  if ($matching.Count -eq 0) {
    $env:RUST_BACKTRACE = 'full'
    $process = Start-Process -FilePath $resolvedExecutable -WorkingDirectory (Split-Path $resolvedExecutable) -PassThru
    $launched = $true
    Write-JsonLine -Path $eventsPath -Data @{
      type = 'process_launched'
      pid = $process.Id
    }
  }
}

try {
  while ((Get-Date) -lt $deadline) {
    $now = Get-Date
    $matching = @(Get-Process -Name 'qingcode' -ErrorAction SilentlyContinue | Where-Object {
        $path = Get-ProcessPathSafely -Process $_
        $path -and $path.ToLowerInvariant() -eq $targetPath
      })

    foreach ($process in $matching) {
      $key = [string]$process.Id
      if (-not $active.ContainsKey($key)) {
        $process.EnableRaisingEvents = $true
        $active[$key] = [pscustomobject]@{
          Process = $process
          StartTime = $process.StartTime
          Path = Get-ProcessPathSafely -Process $process
        }
        $lastStateByPid[$key] = $null
        Write-JsonLine -Path $eventsPath -Data @{
          type = 'process_observed'
          pid = $process.Id
          process_started = $process.StartTime.ToString('o')
          path = $active[$key].Path
        }
      }
    }

    $webViewProcesses = @(Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue)

    foreach ($key in @($active.Keys)) {
      $entry = $active[$key]
      $process = $entry.Process
      $process.Refresh()

      if ($process.HasExited) {
        Start-Sleep -Seconds 3
        $exitCode = Get-ExitCodeSafely -Process $process
        $relatedEvents = @(Get-QingCodeEvents -Since $entry.StartTime.AddSeconds(-2))
        $newDumps = @(Get-ChildItem -LiteralPath $dumpDirectory -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $entry.StartTime.AddSeconds(-2) } |
            Select-Object FullName, Length, LastWriteTime)
        Write-JsonLine -Path $eventsPath -Data @{
          type = 'process_exited'
          pid = [int]$key
          process_started = $entry.StartTime.ToString('o')
          exit_code = $exitCode
          runtime_seconds = [math]::Round(((Get-Date) - $entry.StartTime).TotalSeconds, 1)
          windows_events = $relatedEvents
          dumps = $newDumps
        }
        $active.Remove($key)
        $lastStateByPid.Remove($key)
        continue
      }

      $directWebViews = @($webViewProcesses | Where-Object {
          (Get-ParentIdSafely -Process $_) -eq $process.Id
        })
      $webViewWorkingSet = [long](($directWebViews | Measure-Object -Property WorkingSet64 -Sum).Sum ?? 0)

      $responding = $process.Responding
      $state = if ($responding) { 'responding' } else { 'not_responding' }
      if ($lastStateByPid[$key] -ne $state) {
        Write-JsonLine -Path $eventsPath -Data @{
          type = 'responsiveness_changed'
          pid = $process.Id
          state = $state
        }
        $lastStateByPid[$key] = $state
      }

      $sample = [pscustomobject]@{
        Timestamp = $now.ToString('o')
        Pid = $process.Id
        Responding = $responding
        CPUSeconds = [math]::Round($process.CPU, 3)
        WorkingSetMB = [math]::Round($process.WorkingSet64 / 1MB, 1)
        PrivateMB = [math]::Round($process.PrivateMemorySize64 / 1MB, 1)
        Handles = $process.HandleCount
        Threads = $process.Threads.Count
        WebViewChildren = $directWebViews.Count
        WebViewWorkingSetMB = [math]::Round($webViewWorkingSet / 1MB, 1)
      }
      if ($csvInitialized) {
        $sample | Export-Csv -LiteralPath $samplesPath -NoTypeInformation -Encoding utf8 -Append
      } else {
        $sample | Export-Csv -LiteralPath $samplesPath -NoTypeInformation -Encoding utf8
        $csvInitialized = $true
      }
    }

    $status = [ordered]@{
      monitor_pid = $PID
      updated_at = $now.ToString('o')
      deadline = $deadline.ToString('o')
      executable = $resolvedExecutable
      product_version = $version
      active_pids = @($active.Keys | ForEach-Object { [int]$_ })
      launched_by_monitor = $launched
      dump_directory = $dumpDirectory
    }
    $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusPath -Encoding utf8

    Start-Sleep -Seconds $SampleSeconds
  }
} finally {
  Write-JsonLine -Path $eventsPath -Data @{
    type = 'monitor_stopped'
    monitor_pid = $PID
    active_pids = @($active.Keys | ForEach-Object { [int]$_ })
  }
}
