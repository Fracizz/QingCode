<#
.SYNOPSIS
  构建 QingCode Android APK（无 Gradle，直接调用 aapt2 / javac / d8 / apksigner）。

.DESCRIPTION
  版本号取自 package.json（versionCode 见 scripts/android-version.mjs）。
  签名：
    - 发布构建传 -Release，并通过 -Keystore 或环境变量 QINGCODE_ANDROID_KEYSTORE 提供固定发布密钥库，
      口令来自 QINGCODE_ANDROID_KEYSTORE_PASSWORD / QINGCODE_ANDROID_KEY_PASSWORD，别名来自 QINGCODE_ANDROID_KEY_ALIAS。
    - 本地开发默认使用 Android 标准调试密钥库 ~/.android/debug.keystore（与 Android Studio 共用），
      同一台电脑上的多次构建、多个工作区签名一致，可以直接覆盖安装。
#>
[CmdletBinding()]
param(
  [string]$SdkPlatform,
  [string]$BuildTools,
  [string]$Jdk = $env:JAVA_HOME,
  [string]$OutputApk,
  [string]$Keystore = $env:QINGCODE_ANDROID_KEYSTORE,
  [string]$KeyAlias = $env:QINGCODE_ANDROID_KEY_ALIAS,
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'mobile/android'
$work = Join-Path $root '.dev/android-build'
if (-not $OutputApk) { $OutputApk = Join-Path $root 'release/QingCode-Android.apk' }
$OutputApk = [IO.Path]::GetFullPath($OutputApk)

# 未显式指定时，从 ANDROID_HOME / ANDROID_SDK_ROOT 选择 android-35 与最新的 35.x Build Tools。
$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $SdkPlatform) {
  if (-not $sdk) { throw 'Pass -SdkPlatform or set ANDROID_HOME.' }
  $SdkPlatform = Join-Path $sdk 'platforms/android-35'
}
if (-not $BuildTools) {
  if (-not $sdk) { throw 'Pass -BuildTools or set ANDROID_HOME.' }
  $BuildTools = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
    Where-Object { $_.Name -match '^35\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $BuildTools) { throw "No Build Tools 35.x under $sdk" }
}
if (-not $Jdk) { throw 'Pass -Jdk or set JAVA_HOME to a JDK 17 installation.' }

$env:JAVA_HOME = (Resolve-Path -LiteralPath $Jdk).Path
$env:Path = "$(Join-Path $env:JAVA_HOME 'bin');$env:Path"
$androidJar = Join-Path $SdkPlatform 'android.jar'
$aapt = Join-Path $BuildTools 'aapt2.exe'
$dex = Join-Path $BuildTools 'd8.bat'
$align = Join-Path $BuildTools 'zipalign.exe'
$sign = Join-Path $BuildTools 'apksigner.bat'
$java = Join-Path $env:JAVA_HOME 'bin/javac.exe'
$jar = Join-Path $env:JAVA_HOME 'bin/jar.exe'
$keytool = Join-Path $env:JAVA_HOME 'bin/keytool.exe'
foreach ($required in @($androidJar, $aapt, $dex, $align, $sign, $java, $jar, $keytool)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing Android build dependency $required" }
}

function Invoke-AndroidTool([string]$Tool, [string[]]$Arguments) {
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Tool failed with exit code $LASTEXITCODE" }
}

# 签名配置：发布构建必须使用固定密钥库，避免不同构建之间无法覆盖安装。
if ($Release) {
  if (-not $Keystore -or -not (Test-Path -LiteralPath $Keystore -PathType Leaf)) {
    throw 'Release builds need -Keystore or QINGCODE_ANDROID_KEYSTORE pointing to the release keystore.'
  }
  if (-not $env:QINGCODE_ANDROID_KEYSTORE_PASSWORD) { throw 'Set QINGCODE_ANDROID_KEYSTORE_PASSWORD for release builds.' }
  if (-not $KeyAlias) { throw 'Pass -KeyAlias or set QINGCODE_ANDROID_KEY_ALIAS for release builds.' }
  $storePassword = $env:QINGCODE_ANDROID_KEYSTORE_PASSWORD
  $keyPassword = if ($env:QINGCODE_ANDROID_KEY_PASSWORD) { $env:QINGCODE_ANDROID_KEY_PASSWORD } else { $storePassword }
} elseif ($Keystore) {
  if (-not (Test-Path -LiteralPath $Keystore -PathType Leaf)) { throw "Keystore not found: $Keystore" }
  $storePassword = if ($env:QINGCODE_ANDROID_KEYSTORE_PASSWORD) { $env:QINGCODE_ANDROID_KEYSTORE_PASSWORD } else { 'android' }
  $keyPassword = if ($env:QINGCODE_ANDROID_KEY_PASSWORD) { $env:QINGCODE_ANDROID_KEY_PASSWORD } else { $storePassword }
  if (-not $KeyAlias) { $KeyAlias = 'androiddebugkey' }
} else {
  $Keystore = Join-Path $HOME '.android/debug.keystore'
  $storePassword = 'android'
  $keyPassword = 'android'
  $KeyAlias = 'androiddebugkey'
  if (-not (Test-Path -LiteralPath $Keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Keystore) | Out-Null
    Invoke-AndroidTool $keytool @('-genkeypair', '-keystore', $Keystore, '-storepass', 'android',
      '-keypass', 'android', '-alias', 'androiddebugkey', '-dname', 'CN=Android Debug,O=Android,C=US',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000')
  }
  Write-Warning "Signing with the local debug keystore $Keystore. Use -Release with the release keystore for published APKs."
}

$version = node (Join-Path $PSScriptRoot 'android-version.mjs') | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $version.code) { throw 'Failed to derive the Android version from package.json.' }
Write-Host "QingCode Android $($version.name) (versionCode $($version.code))"

$stage = Join-Path $work "stage-$([Guid]::NewGuid().ToString('N'))"
$classes = Join-Path $stage 'classes'
$assets = Join-Path $stage 'assets'
$bytecode = Join-Path $stage 'dex'
$resources = Join-Path $stage 'res'
$drawables = Join-Path $resources 'drawable-nodpi'
New-Item -ItemType Directory -Path $classes,$assets,$bytecode,$drawables,(Split-Path -Parent $OutputApk) -Force | Out-Null
try {
  foreach ($asset in @('index.html', 'app.css', 'app.js', 'protocol.js', 'scanner.js', 'terminalTouch.js', 'gestures.js', 'composer.js', 'terminalHistory.js', 'terminalScrollbar.js', 'terminalJog.js', 'terminalHold.js', 'historyRender.js', 'terminalSelection.js', 'connectionLatency.js', 'workspaceState.js', 'nativeRpc.js', 'terminalInput.js', 'desktopProtocol.js', 'terminalImages.js', 'dom.js', 'dashboardView.js', 'pairingFlow.js', 'outputReader.js', 'composeStatus.js', 'sessionDrawer.js', 'terminalSettings.js', 'shortcutBar.js', 'keyLayout.js', 'cursorDrag.js', 'pinchZoom.js', 'terminalLinks.js')) {
    Copy-Item -LiteralPath (Join-Path $source "web/$asset") -Destination $assets
  }
  Copy-Item -LiteralPath (Join-Path $source 'res/values') -Destination $resources -Recurse
  # The 256 px PNG matches the 256 px frame of the Windows installer ICO.
  $icon = Join-Path $root 'src-tauri/icons/128x128@2x.png'
  Copy-Item -LiteralPath $icon -Destination (Join-Path $drawables 'ic_qingcode.png')
  Copy-Item -LiteralPath $icon -Destination (Join-Path $assets 'qingcode-icon.png')
  $modules = Join-Path $root 'node_modules'
  Copy-Item -LiteralPath (Join-Path $modules '@xterm/xterm/lib/xterm.js') -Destination $assets
  Copy-Item -LiteralPath (Join-Path $modules '@xterm/xterm/css/xterm.css') -Destination $assets
  Copy-Item -LiteralPath (Join-Path $modules '@xterm/addon-fit/lib/addon-fit.js') -Destination (Join-Path $assets 'fit.js')
  Copy-Item -LiteralPath (Join-Path $modules 'jsqr/dist/jsQR.js') -Destination (Join-Path $assets 'jsqr.js')
  Copy-Item -LiteralPath (Join-Path $modules '@xterm/xterm/LICENSE') -Destination (Join-Path $assets 'xterm-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $modules '@xterm/addon-fit/LICENSE') -Destination (Join-Path $assets 'fit-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $modules 'jsqr/LICENSE') -Destination (Join-Path $assets 'jsqr-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $modules 'lucide-react/LICENSE') -Destination (Join-Path $assets 'lucide-LICENSE.txt')

  $compiled = Join-Path $stage 'resources.zip'
  $unsigned = Join-Path $stage 'unsigned.apk'
  $aligned = Join-Path $stage 'aligned.apk'
  $signed = Join-Path $stage 'signed.apk'
  Invoke-AndroidTool $aapt @('compile', '--dir', $resources, '-o', $compiled)
  Invoke-AndroidTool $aapt @('link', '-I', $androidJar, '--manifest', (Join-Path $source 'AndroidManifest.xml'),
    '--version-code', [string]$version.code, '--version-name', [string]$version.name, '--replace-version',
    '-A', $assets, '-o', $unsigned, $compiled)
  $javaSources = @(Get-ChildItem -LiteralPath $source -Filter '*.java' -File | ForEach-Object FullName)
  Invoke-AndroidTool $java (@('--release', '8', '-encoding', 'UTF-8', '-Xlint:-options', '-cp', $androidJar, '-d', $classes) + $javaSources)
  $classFiles = Get-ChildItem -LiteralPath $classes -Filter '*.class' -Recurse | ForEach-Object FullName
  Invoke-AndroidTool $dex (@('--min-api', '26', '--lib', $androidJar, '--output', $bytecode) + $classFiles)
  Invoke-AndroidTool $jar @('uf', $unsigned, '-C', $bytecode, 'classes.dex')
  Invoke-AndroidTool $align @('-f', '-p', '4', $unsigned, $aligned)

  # 口令经环境变量传给 apksigner，不出现在命令行参数里。
  $env:QINGCODE_APKSIGNER_STORE_PASS = $storePassword
  $env:QINGCODE_APKSIGNER_KEY_PASS = $keyPassword
  try {
    Invoke-AndroidTool $sign @('sign', '--ks', $Keystore, '--ks-pass', 'env:QINGCODE_APKSIGNER_STORE_PASS',
      '--ks-key-alias', $KeyAlias, '--key-pass', 'env:QINGCODE_APKSIGNER_KEY_PASS', '--out', $signed, $aligned)
  } finally {
    Remove-Item Env:QINGCODE_APKSIGNER_STORE_PASS, Env:QINGCODE_APKSIGNER_KEY_PASS -ErrorAction SilentlyContinue
  }
  Invoke-AndroidTool $sign @('verify', '--print-certs', $signed)
  Invoke-AndroidTool $align @('-c', '-p', '4', $signed)
  Copy-Item -LiteralPath $signed -Destination $OutputApk -Force
  Get-FileHash -LiteralPath $OutputApk -Algorithm SHA256
} finally {
  $verified = (Resolve-Path -LiteralPath $stage).Path
  $prefix = (Resolve-Path -LiteralPath $work).Path.TrimEnd('\') + '\'
  if ($verified.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $verified -Recurse -Force
  }
}
