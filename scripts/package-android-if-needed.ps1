# Local companion APK packaging. Desktop-only/version-only changes reuse the existing APK.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localSdk = Join-Path $projectRoot '.dev/android-build/sdk'
$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, $localSdk) |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$platform = if ($sdk) {
  @((Join-Path $sdk 'platforms/android-35'), (Join-Path $sdk 'platform/android-35')) |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'android.jar') } | Select-Object -First 1
}
$buildTools = if ($sdk -and (Test-Path -LiteralPath (Join-Path $sdk 'build-tools'))) {
  Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
    Where-Object { ($_.Name -match '^35\.\d+\.\d+$' -or $_.Name -eq 'android-15') -and
      (Test-Path -LiteralPath (Join-Path $_.FullName 'apksigner.bat')) } |
    Sort-Object { if ($_.Name -eq 'android-15') { [version]'35.0.0' } else { [version]$_.Name } } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
$jdk = $env:JAVA_HOME
if ($jdk) {
  $javac = Join-Path $jdk 'bin/javac.exe'
  if (-not (Test-Path -LiteralPath $javac) -or
      "$(& $javac -version 2>&1)" -notmatch 'javac (1[7-9]|[2-9][0-9])\.') { $jdk = $null }
}
if (-not $jdk -and (Test-Path -LiteralPath (Join-Path $localSdk 'jdk'))) {
  $jdk = Get-ChildItem -LiteralPath (Join-Path $localSdk 'jdk') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/javac.exe') } |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $platform -or -not $buildTools -or -not $jdk) {
  Write-Host '  APK skipped: configure ANDROID_HOME and JAVA_HOME (SDK 35 / Build Tools 35.x / JDK 17).'
  return
}

# Retain the signing identity used by earlier local builds.
$keystore = $env:QINGCODE_ANDROID_KEYSTORE
if ($keystore -and -not (Test-Path -LiteralPath $keystore -PathType Leaf)) {
  throw 'QINGCODE_ANDROID_KEYSTORE points to a missing keystore; refusing to change signing identity.'
}
$legacyKey = Join-Path $projectRoot '.dev/android-build/qingcode-android-debug.jks'
if (-not $keystore -and (Test-Path -LiteralPath $legacyKey)) { $keystore = $legacyKey }
if (-not $keystore) { $keystore = Join-Path $env:USERPROFILE '.android/debug.keystore' }
$statePath = Join-Path $projectRoot '.dev/android-build/package-state.json'
$inputs = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'mobile/android') -File -Recurse | ForEach-Object FullName)
$inputs += @('scripts/build-android.ps1', 'scripts/android-version.mjs', 'scripts/package-android-if-needed.ps1',
  'src-tauri/icons/128x128@2x.png', 'node_modules/@xterm/xterm/lib/xterm.js',
  'node_modules/@xterm/xterm/css/xterm.css', 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  'node_modules/jsqr/dist/jsQR.js', 'node_modules/@xterm/xterm/LICENSE',
  'node_modules/@xterm/addon-fit/LICENSE', 'node_modules/jsqr/LICENSE') | ForEach-Object { Join-Path $projectRoot $_ }
function Get-AndroidFingerprint {
  $files = @($inputs)
  if (Test-Path -LiteralPath $keystore) { $files += $keystore }
  $parts = @($files | Sort-Object | ForEach-Object { "$_=$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)" })
  $parts += "alias=$env:QINGCODE_ANDROID_KEY_ALIAS"
  $bytes = [Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}
$fingerprint = Get-AndroidFingerprint
if (Test-Path -LiteralPath $statePath) {
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.fingerprint -eq $fingerprint -and (Test-Path -LiteralPath $state.artifact) -and
        (Get-FileHash -LiteralPath $state.artifact -Algorithm SHA256).Hash -eq $state.sha256) {
      $aliasPath = Join-Path $projectRoot 'release/QingCode-Android.apk'
      if (-not (Test-Path -LiteralPath $aliasPath) -or
          (Get-FileHash -LiteralPath $aliasPath -Algorithm SHA256).Hash -ne $state.sha256) {
        Copy-Item -LiteralPath $state.artifact -Destination $aliasPath -Force
      }
      Write-Host "  APK unchanged; reuse $($state.artifact)"
      return
    }
  } catch { Write-Host '  APK cache invalid; rebuild.' }
}
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$artifact = Join-Path $projectRoot "release/QingCode_${version}-android.apk"
$buildArgs = @{ SdkPlatform = $platform; BuildTools = $buildTools; Jdk = $jdk; OutputApk = $artifact }
if (Test-Path -LiteralPath $keystore) { $buildArgs.Keystore = $keystore }
& (Join-Path $PSScriptRoot 'build-android.ps1') @buildArgs
if ($LASTEXITCODE -ne 0) { throw "Android build failed: $LASTEXITCODE" }
Copy-Item -LiteralPath $artifact -Destination (Join-Path $projectRoot 'release/QingCode-Android.apk') -Force
New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
@{ fingerprint = Get-AndroidFingerprint; artifact = $artifact; sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash } |
  ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
