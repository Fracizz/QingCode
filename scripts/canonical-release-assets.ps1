# Shared canonical GitHub/Gitee Release asset names (one file per platform/channel).
# Dot-source from release workflows / publish scripts:
#   . "$PSScriptRoot/canonical-release-assets.ps1"

function Get-CanonicalReleaseAssetNames {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version
  )
  if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version is required'
  }
  if ($Version.StartsWith('v')) {
    $Version = $Version.Substring(1)
  }
  @(
    "QingCode_${Version}-windows-x64.exe",
    "QingCode_${Version}-windows-x64-setup.exe",
    "QingCode_${Version}-windows-arm64.exe",
    "QingCode_${Version}-windows-arm64-setup.exe",
    "QingCode_${Version}-macos-arm64.dmg",
    "QingCode_${Version}-macos-arm64.zip"
  )
}

# Offline remote-Server package; docs/server-offline-update.md tells users to download it from
# GitHub or Gitee Releases, so the Gitee mirror must carry it too.
function Get-OfflineServerReleaseAssetNames {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version
  )
  if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version is required'
  }
  if ($Version.StartsWith('v')) {
    $Version = $Version.Substring(1)
  }
  @("QingCode_${Version}-servers.zip")
}

# Assets published only when their build prerequisites exist (Android needs the release keystore).
function Get-OptionalReleaseAssetNames {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version
  )
  if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version is required'
  }
  if ($Version.StartsWith('v')) {
    $Version = $Version.Substring(1)
  }
  @("QingCode_${Version}-android.apk")
}

function Select-CanonicalReleaseFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string[]]$Paths
  )
  $keep = Get-CanonicalReleaseAssetNames -Version $Version
  $byName = @{}
  foreach ($path in @($Paths)) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    $name = [IO.Path]::GetFileName($path)
    if (-not $byName.ContainsKey($name)) {
      $byName[$name] = (Resolve-Path -LiteralPath $path).Path
    }
  }
  $selected = New-Object System.Collections.Generic.List[string]
  $missing = New-Object System.Collections.Generic.List[string]
  foreach ($name in $keep) {
    if ($byName.ContainsKey($name)) {
      $selected.Add([string]$byName[$name]) | Out-Null
    } else {
      $missing.Add($name) | Out-Null
    }
  }
  if ($missing.Count -gt 0) {
    throw ("Missing canonical release asset(s): {0}" -f ($missing -join ', '))
  }
  foreach ($name in (Get-OptionalReleaseAssetNames -Version $Version)) {
    if ($byName.ContainsKey($name)) {
      $selected.Add([string]$byName[$name]) | Out-Null
    }
  }
  foreach ($name in (Get-OfflineServerReleaseAssetNames -Version $Version)) {
    if ($byName.ContainsKey($name)) {
      $selected.Add([string]$byName[$name]) | Out-Null
    }
  }
  return $selected.ToArray()
}
