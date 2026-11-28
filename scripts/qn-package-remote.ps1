$ErrorActionPreference = 'Stop'
$repo = 'D:/Code/qingcode-next-build'
$archive = 'D:/Code/QingCode-next/release'
$toolchain = 'D:/Code/.qn-toolchain'
$branch = $env:QN_PACKAGE_BRANCH
$commit = $env:QN_PACKAGE_COMMIT
$target = $env:QN_PACKAGE_TARGET
$channel = $env:QN_PACKAGE_CHANNEL
$base = $env:QN_PACKAGE_BASE_VERSION
$transferName = $env:QN_PACKAGE_TRANSFER
if ($target -notin @('all', 'desktop', 'android') -or $channel -notin @('beta', 'stable') -or
    $commit -notmatch '^[0-9a-f]{40}$' -or $transferName -notmatch '^qn-package-[0-9a-f]{12}$' -or
    ($base -and $base -notmatch '^\d+\.\d+\.\d+$')) { throw 'Invalid QingCode packaging options' }

$transfer = Join-Path 'D:/Download' $transferName
$desktopRelease = Join-Path $repo 'apps/desktop/release'

function Invoke-BuildStep([scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "Build step failed ($LASTEXITCODE): $command" }
}

# 三个客户端共享一份 Windows 构建树。排队后再分配版本，避免同时覆盖构建产物。
$lock = [Threading.Mutex]::new($false, 'QingCodeNextProjectPackaging')
try {
  try {
    $acquired = $lock.WaitOne([TimeSpan]::FromMinutes(12))
  } catch [Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (!$acquired) { throw 'The Windows build checkout is still busy' }
  Set-Location -LiteralPath $repo
  if (git status --porcelain --untracked-files=no) { throw 'The Windows build checkout has tracked changes' }
  if ((git rev-parse HEAD) -ne $commit) {
    Invoke-BuildStep { git fetch origin $branch }
    Invoke-BuildStep { git merge --ff-only $commit }
    if ((git rev-parse HEAD) -ne $commit) { throw 'The Windows build checkout did not reach the requested commit' }
  }

  $history = @(Get-ChildItem -LiteralPath $archive -File | ForEach-Object {
    if ($_.Name -match '^QingCode-Next-(\d+\.\d+\.\d+)(?:-beta\.(\d+))?-(?:x64\.exe|android\.apk)$') {
      [pscustomobject]@{ Base = [version]$Matches[1]; Beta = [long]($Matches[2] ?? 0) }
    }
  })
  if (!$base) {
    $manifestBase = ((Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version -split '-')[0]
    $base = @([version]$manifestBase; $history.Base) | Sort-Object -Descending | Select-Object -First 1
    $base = $base.ToString()
  }
  $version = $base
  if ($channel -eq 'beta') {
    $last = $history | Where-Object { $_.Base -eq [version]$base } | Measure-Object -Property Beta -Maximum
    $number = [long]$last.Maximum + 1
    do {
      $version = "$base-beta.$number"
      $number++
    } while (Test-Path -LiteralPath (Join-Path $desktopRelease $version))
  }
  $installerName = "QingCode-Next-$version-x64.exe"
  $apkName = "QingCode-Next-$version-android.apk"
  $names = @()
  if ($target -ne 'android') { $names += $installerName }
  if ($target -ne 'desktop') { $names += $apkName }
  if ($names | Where-Object { Test-Path -LiteralPath (Join-Path $archive $_) }) {
    throw "The archive already contains $version"
  }

  New-Item -ItemType Directory -Path $transfer | Out-Null
  if ($target -ne 'android') {
    $env:QINGCODE_PACKAGE_CHANNEL = $channel
    $env:QINGCODE_PACKAGE_BASE_VERSION = $base
    Invoke-BuildStep { pnpm build }
    Invoke-BuildStep {
      pnpm --filter @qn/desktop exec electron-builder --win nsis --x64 --publish never `
        "-c.extraMetadata.version=$version" "-c.directories.output=release/$version"
    }
    $output = Join-Path $desktopRelease $version
    Copy-Item -LiteralPath (Join-Path $output $installerName) -Destination $transfer
  }
  if ($target -ne 'desktop') {
    $env:JAVA_HOME = Join-Path $toolchain 'jdk'
    $env:ANDROID_HOME = Join-Path $toolchain 'android-sdk'
    Invoke-BuildStep { pnpm --filter @qn/mobile build:web }
    & ./apps/mobile/android/build-android.ps1 -VersionName $version -OutputApk (Join-Path $transfer $apkName)
  }

  $hashes = foreach ($name in $names) {
    $file = Get-Item -LiteralPath (Join-Path $transfer $name)
    if (!$file.Length) { throw "Empty package: $name" }
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name"
  }
  Set-Content -LiteralPath (Join-Path $transfer 'SHA256SUMS') -Value $hashes -Encoding ascii
  foreach ($name in $names) {
    Copy-Item -LiteralPath (Join-Path $transfer $name) -Destination $archive
  }
  "QN_PACKAGE_READY $version"
} finally {
  if ($acquired) { $lock.ReleaseMutex() }
  $lock.Dispose()
}
