<#
.SYNOPSIS
  无 Gradle 构建 QingCode Next Android APK。

.DESCRIPTION
  直接调用 aapt2 / javac / d8 / jar / zipalign / apksigner。
  默认工具链取 JAVA_HOME / ANDROID_HOME，缺失时回退到仓库同级 .qn-toolchain。
  签名仅用于本地调试；发布密钥由总管另行提供。
#>
[CmdletBinding()]
param(
  [string]$Jdk = $env:JAVA_HOME,
  [string]$SdkPlatform,
  [string]$BuildTools,
  [string]$OutputApk
)

$ErrorActionPreference = 'Stop'

$android = $PSScriptRoot
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$mobileRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$toolchainRoot = Join-Path (Split-Path -Parent $repoRoot) '.qn-toolchain'
if (-not $OutputApk) {
  $OutputApk = Join-Path $mobileRoot 'release/QingCode-Next-Android.apk'
}
$OutputApk = [IO.Path]::GetFullPath($OutputApk)

if (-not $Jdk) { $Jdk = Join-Path $toolchainRoot 'jdk' }
if (-not (Test-Path -LiteralPath (Join-Path $Jdk 'bin/javac.exe') -PathType Leaf)) {
  $fallback = Join-Path $toolchainRoot 'jdk'
  if (Test-Path -LiteralPath (Join-Path $fallback 'bin/javac.exe') -PathType Leaf) {
    $Jdk = $fallback
  } else {
    throw 'Pass -Jdk or set JAVA_HOME to a JDK 17 installation.'
  }
}
$env:JAVA_HOME = (Resolve-Path -LiteralPath $Jdk).Path
$env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path

$sdk = $env:ANDROID_HOME
if (-not $sdk -or -not (Test-Path -LiteralPath $sdk -PathType Container)) {
  $sdk = $env:ANDROID_SDK_ROOT
}
if (-not $sdk -or -not (Test-Path -LiteralPath $sdk -PathType Container)) {
  $sdk = Join-Path $toolchainRoot 'android-sdk'
}
if (-not (Test-Path -LiteralPath $sdk -PathType Container)) {
  throw 'Pass -SdkPlatform / -BuildTools or set ANDROID_HOME.'
}
if (-not $SdkPlatform) { $SdkPlatform = Join-Path $sdk 'platforms/android-35' }
if (-not $BuildTools) {
  $preferred = Join-Path $sdk 'build-tools/35.0.0'
  if (Test-Path -LiteralPath $preferred -PathType Container) {
    $BuildTools = $preferred
  } else {
    $BuildTools = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
      Where-Object { $_.Name -match '^35\.\d+\.\d+$' } |
      Sort-Object { [version]$_.Name } -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $BuildTools) { throw "No Build Tools 35.x under $sdk" }

$androidJar = Join-Path $SdkPlatform 'android.jar'
$aapt2 = Join-Path $BuildTools 'aapt2.exe'
$d8 = Join-Path $BuildTools 'd8.bat'
$zipalign = Join-Path $BuildTools 'zipalign.exe'
$apksigner = Join-Path $BuildTools 'apksigner.bat'
$javac = Join-Path $env:JAVA_HOME 'bin/javac.exe'
$jar = Join-Path $env:JAVA_HOME 'bin/jar.exe'
$keytool = Join-Path $env:JAVA_HOME 'bin/keytool.exe'
foreach ($required in @($androidJar, $aapt2, $d8, $zipalign, $apksigner, $javac, $jar, $keytool)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing Android build dependency $required"
  }
}

function Invoke-Tool([string]$Tool, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Tool @Arguments
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw "$Tool failed with exit code $LASTEXITCODE" }
}

function Add-WebAssets([string]$ApkPath, [string]$AssetsRoot) {
  # Windows 上 aapt2 -A 会把嵌套目录写成反斜杠；jar 显式指定条目可保留 AssetManager 需要的正斜杠。
  $separators = [char[]]@([char]92, [char]47)
  $root = (Resolve-Path -LiteralPath $AssetsRoot).Path.TrimEnd($separators)
  $arguments = @('uf', $ApkPath)
  foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
    $relative = $file.FullName.Substring($root.Length).TrimStart($separators)
    $entryName = $relative.Replace('\', '/')
    if (-not $entryName.StartsWith('assets/')) { throw "Unexpected asset path $entryName" }
    $arguments += @('-C', $root, $entryName)
  }
  Invoke-Tool $jar $arguments
}

$packageJson = Join-Path $mobileRoot 'package.json'
$package = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
$versionName = [string]$package.version
$versionMatch = [regex]::Match($versionName, '^(\d+)\.(\d+)\.(\d+)')
if (-not $versionMatch.Success) { throw "Invalid version in $packageJson : $versionName" }
# versionCode 从语义化版本前三位推导，保证同一 versionName 的覆盖安装不会降级。
$versionCode = [int]$versionMatch.Groups[1].Value * 10000 +
  [int]$versionMatch.Groups[2].Value * 100 +
  [int]$versionMatch.Groups[3].Value
if ($env:QN_ANDROID_VERSION_CODE) { $versionCode = [int]$env:QN_ANDROID_VERSION_CODE }
if ($versionCode -lt 1) { $versionCode = 1 }
Write-Host "QingCode Next Android $versionName (versionCode $versionCode)"

$keystore = Join-Path $android '.debug.keystore'
$keyAlias = 'androiddebugkey'
$storePassword = 'android'
$keyPassword = 'android'
if (-not (Test-Path -LiteralPath $keystore -PathType Leaf)) {
  Invoke-Tool $keytool @('-genkeypair', '-keystore', $keystore,
    '-storepass', $storePassword, '-keypass', $keyPassword,
    '-alias', $keyAlias, '-dname', 'CN=QingCode Next Debug,O=QingCode Next,C=CN',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storetype', 'PKCS12')
}

$buildRoot = Join-Path $android 'build'
$stage = Join-Path $buildRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
$classes = Join-Path $stage 'classes'
$dexDir = Join-Path $stage 'dex'
$apkAssets = Join-Path $stage 'apk-assets'
$resStage = Join-Path $stage 'res'
$compiled = Join-Path $stage 'resources.zip'
$unsigned = Join-Path $stage 'unsigned.apk'
$aligned = Join-Path $stage 'aligned.apk'
$signed = Join-Path $stage 'signed.apk'
$manifest = Join-Path $android 'AndroidManifest.xml'
New-Item -ItemType Directory -Force -Path $classes, $dexDir, $apkAssets, $resStage,
  (Split-Path -Parent $OutputApk) | Out-Null

try {
  $sourceAssets = Join-Path $android 'assets'
  $sourceRes = Join-Path $android 'res'
  $sourceJava = Join-Path $android 'src'
  if (-not (Test-Path -LiteralPath (Join-Path $sourceAssets 'web/index.html') -PathType Leaf)) {
    throw 'Missing assets/web/index.html; run T11 web build or keep the placeholder.'
  }
  $assetTarget = Join-Path $apkAssets 'assets'
  New-Item -ItemType Directory -Force -Path $assetTarget | Out-Null
  Get-ChildItem -LiteralPath $sourceAssets -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $assetTarget -Recurse -Force
  }
  Get-ChildItem -LiteralPath $sourceRes -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $resStage -Recurse -Force
  }
  $javaSources = @(Get-ChildItem -LiteralPath $sourceJava -Filter '*.java' -Recurse -File |
    ForEach-Object { $_.FullName })
  if ($javaSources.Count -eq 0) { throw "No Java sources under $sourceJava" }

  Invoke-Tool $aapt2 @('compile', '--dir', $resStage, '-o', $compiled)
  Invoke-Tool $aapt2 @('link', '-I', $androidJar, '--manifest', $manifest,
    '--version-code', [string]$versionCode, '--version-name', $versionName,
    '--replace-version', '-o', $unsigned, $compiled)
  Invoke-Tool $javac (@('--release', '17', '-encoding', 'UTF-8', '-Xlint:-options',
    '-cp', $androidJar, '-d', $classes) + $javaSources)
  $classFiles = @(Get-ChildItem -LiteralPath $classes -Filter '*.class' -Recurse -File |
    ForEach-Object { $_.FullName })
  if ($classFiles.Count -eq 0) { throw 'javac produced no class files' }
  Invoke-Tool $d8 (@('--min-api', '26', '--lib', $androidJar, '--output', $dexDir) + $classFiles)
  Invoke-Tool $jar @('uf', $unsigned, '-C', $dexDir, 'classes.dex')
  Add-WebAssets $unsigned $apkAssets
  Invoke-Tool $zipalign @('-f', '-p', '4', $unsigned, $aligned)

  $env:QN_APKSIGNER_STORE_PASS = $storePassword
  $env:QN_APKSIGNER_KEY_PASS = $keyPassword
  try {
    Invoke-Tool $apksigner @('sign', '--ks', $keystore, '--ks-pass',
      'env:QN_APKSIGNER_STORE_PASS', '--ks-key-alias', $keyAlias, '--key-pass',
      'env:QN_APKSIGNER_KEY_PASS', '--out', $signed, $aligned)
  } finally {
    Remove-Item Env:QN_APKSIGNER_STORE_PASS, Env:QN_APKSIGNER_KEY_PASS -ErrorAction SilentlyContinue
  }
  Invoke-Tool $apksigner @('verify', '--print-certs', $signed)
  Invoke-Tool $zipalign @('-c', '-p', '4', $signed)
  Copy-Item -LiteralPath $signed -Destination $OutputApk -Force
  Invoke-Tool $apksigner @('verify', $OutputApk)
  Invoke-Tool $aapt2 @('dump', 'badging', $OutputApk)
  $hash = Get-FileHash -LiteralPath $OutputApk -Algorithm SHA256
  Write-Host "APK: $OutputApk"
  Write-Host "SHA256: $($hash.Hash)"
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
