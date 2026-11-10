<#
.SYNOPSIS
  按策略清理 src-tauri/target，防止 Rust 构建缓存无限增长。

.DESCRIPTION
  1. 增量编译缓存（各配置下的 incremental/<crate>-<hash>）：超过 -MaxAgeDays 天未更新的删除；
     剩余总量仍超过 -MaxIncrementalGB 时，从最久未更新的开始删到上限以内。
  2. 整个 target 仍超过 -MaxTargetGB 时，从最久未用的构建配置（如 debug、server-release、
     <triple>/debug）开始清掉 deps / build / .fingerprint / incremental，相当于对该配置 cargo clean。
  删除只影响下次编译速度，不影响源码。有 rustc 正在往该 target 输出时跳过（-Force 例外）。

  tauri-dev.ps1 每次启动先跑一次；-RegisterDailyTask 另注册每日计划任务（当前用户，登录时运行）。

.EXAMPLE
  pwsh -File scripts/prune-rust-target.ps1 -DryRun
  pwsh -File scripts/prune-rust-target.ps1 -RegisterDailyTask
#>
[CmdletBinding()]
param(
  [string]$TargetDir,
  [int]$MaxAgeDays = 7,
  [double]$MaxIncrementalGB = 10,
  [double]$MaxTargetGB = 50,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$RegisterDailyTask,
  [switch]$UnregisterDailyTask
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $TargetDir) { $TargetDir = Join-Path $projectRoot 'src-tauri\target' }
$TargetDir = [System.IO.Path]::GetFullPath($TargetDir)
$taskName = 'QingCode prune Rust target'

if ($UnregisterDailyTask) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除计划任务「$taskName」"
  return
}

if ($RegisterDailyTask) {
  $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
  if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -TargetDir `"$TargetDir`" " +
    "-MaxAgeDays $MaxAgeDays -MaxIncrementalGB $MaxIncrementalGB -MaxTargetGB $MaxTargetGB"
  $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $projectRoot
  $trigger = New-ScheduledTaskTrigger -Daily -At 4am
  # 错过时间（关机、未登录）后尽快补跑；单次最多 1 小时。
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "按策略清理 $TargetDir（增量缓存 ${MaxAgeDays} 天 / ${MaxIncrementalGB}GB，总量 ${MaxTargetGB}GB）" `
    -Force | Out-Null
  Write-Host "已注册每日 04:00 计划任务「$taskName」"
  return
}

if (-not (Test-Path -LiteralPath $TargetDir)) { return }

function Get-DirBytes([string]$Path) {
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Measure-Object Length -Sum).Sum
  if ($sum) { [long]$sum } else { 0L }
}

function Format-GB([long]$Bytes) { '{0:N1} GB' -f ($Bytes / 1GB) }

$script:removedBytes = 0L

function Remove-Entry([string]$Path, [string]$Reason, [long]$Bytes = -1) {
  if ($Bytes -lt 0) { $Bytes = Get-DirBytes $Path }
  if ($DryRun) {
    Write-Host "[dry-run] 删除 $Path（$(Format-GB $Bytes)，$Reason）"
    $script:removedBytes += $Bytes
    return $true
  }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    Write-Host "已删除 $Path（$(Format-GB $Bytes)，$Reason）"
    $script:removedBytes += $Bytes
    return $true
  }
  catch {
    # 文件被占用（例如正在运行的 qingcode.exe）时跳过，下次再清。
    Write-Warning "跳过 $Path：$($_.Exception.Message)"
    return $false
  }
}

$busy = Get-CimInstance Win32_Process -Filter "Name = 'rustc.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($TargetDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
if ($busy -and -not $Force) {
  Write-Host "有 rustc 正在输出到 $TargetDir，本次跳过清理。"
  return
}

$before = Get-DirBytes $TargetDir
$cutoff = (Get-Date).AddDays(-$MaxAgeDays)

# 1. 增量编译缓存：先按时间，再按容量。
$incrementalRoots = Get-ChildItem -LiteralPath $TargetDir -Recurse -Directory -Depth 3 -Filter incremental -ErrorAction SilentlyContinue
$entries = foreach ($root in $incrementalRoots) {
  Get-ChildItem -LiteralPath $root.FullName -Directory -Force -ErrorAction SilentlyContinue
}
$kept = [System.Collections.Generic.List[object]]::new()
foreach ($entry in $entries) {
  if ($entry.LastWriteTime -lt $cutoff) {
    [void](Remove-Entry $entry.FullName "超过 $MaxAgeDays 天未使用")
  }
  else {
    $kept.Add([pscustomobject]@{ Path = $entry.FullName; Time = $entry.LastWriteTime; Bytes = Get-DirBytes $entry.FullName })
  }
}
$incrementalBytes = ($kept | Measure-Object Bytes -Sum).Sum
$capBytes = [long]($MaxIncrementalGB * 1GB)
if ($incrementalBytes -gt $capBytes) {
  foreach ($item in ($kept | Sort-Object Time)) {
    if ($incrementalBytes -le $capBytes) { break }
    if (Remove-Entry $item.Path "增量缓存超过 $MaxIncrementalGB GB 上限" $item.Bytes) { $incrementalBytes -= $item.Bytes }
  }
}

# 2. 总量上限：按构建配置从最久未用的开始清。
$totalCap = [long]($MaxTargetGB * 1GB)
$total = $before - $script:removedBytes
if ($total -gt $totalCap) {
  $profiles = Get-ChildItem -LiteralPath $TargetDir -Recurse -Directory -Depth 2 -Filter deps -ErrorAction SilentlyContinue |
    ForEach-Object { $_.Parent } | Sort-Object LastWriteTime
  foreach ($profileDir in $profiles) {
    if ($total -le $totalCap) { break }
    $removedBefore = $script:removedBytes
    foreach ($name in 'deps', 'build', '.fingerprint', 'incremental') {
      $path = Join-Path $profileDir.FullName $name
      if (Test-Path -LiteralPath $path) { [void](Remove-Entry $path "target 超过 $MaxTargetGB GB 总上限") }
    }
    $total -= $script:removedBytes - $removedBefore
  }
}

$after = $before - $script:removedBytes
Write-Host "Rust target 清理完成：$(Format-GB $before) → $(Format-GB $after)（$TargetDir）"
