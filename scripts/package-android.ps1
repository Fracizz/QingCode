# Local companion APK packaging. Always rebuilds the APK so local packaging never ships a stale artifact.
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
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$artifact = Join-Path $projectRoot "release/QingCode_${version}-android.apk"
$buildArgs = @{ SdkPlatform = $platform; BuildTools = $buildTools; Jdk = $jdk; OutputApk = $artifact }
if (Test-Path -LiteralPath $keystore) { $buildArgs.Keystore = $keystore }
& (Join-Path $PSScriptRoot 'build-android.ps1') @buildArgs
if ($LASTEXITCODE -ne 0) { throw "Android build failed: $LASTEXITCODE" }
Copy-Item -LiteralPath $artifact -Destination (Join-Path $projectRoot 'release/QingCode-Android.apk') -Force
