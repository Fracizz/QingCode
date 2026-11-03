[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SdkPlatform,
  [Parameter(Mandatory)][string]$BuildTools,
  [string]$Jdk = $env:JAVA_HOME,
  [string]$OutputApk
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'mobile/android'
$work = Join-Path $root '.dev/android-build'
if (-not $OutputApk) { $OutputApk = Join-Path $root 'release/QingCode-Android.apk' }
$OutputApk = [IO.Path]::GetFullPath($OutputApk)
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

$stage = Join-Path $work "stage-$([Guid]::NewGuid().ToString('N'))"
$classes = Join-Path $stage 'classes'
$assets = Join-Path $stage 'assets'
$bytecode = Join-Path $stage 'dex'
New-Item -ItemType Directory -Path $classes,$assets,$bytecode,(Split-Path -Parent $OutputApk) -Force | Out-Null
try {
  foreach ($asset in @('index.html', 'app.css', 'app.js')) {
    Copy-Item -LiteralPath (Join-Path $source "web/$asset") -Destination $assets
  }
  Copy-Item -LiteralPath (Join-Path $root 'node_modules/@xterm/xterm/lib/xterm.js') -Destination $assets
  Copy-Item -LiteralPath (Join-Path $root 'node_modules/@xterm/xterm/css/xterm.css') -Destination $assets
  Copy-Item -LiteralPath (Join-Path $root 'node_modules/@xterm/addon-fit/lib/addon-fit.js') -Destination (Join-Path $assets 'fit.js')
  Copy-Item -LiteralPath (Join-Path $root 'node_modules/@xterm/xterm/LICENSE') -Destination (Join-Path $assets 'xterm-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $root 'node_modules/@xterm/addon-fit/LICENSE') -Destination (Join-Path $assets 'fit-LICENSE.txt')

  $compiled = Join-Path $stage 'resources.zip'
  $unsigned = Join-Path $stage 'unsigned.apk'
  $aligned = Join-Path $stage 'aligned.apk'
  $signed = Join-Path $stage 'signed.apk'
  Invoke-AndroidTool $aapt @('compile', '--dir', (Join-Path $source 'res'), '-o', $compiled)
  Invoke-AndroidTool $aapt @('link', '-I', $androidJar, '--manifest', (Join-Path $source 'AndroidManifest.xml'), '-A', $assets, '-o', $unsigned, $compiled)
  Invoke-AndroidTool $java @('--release', '8', '-encoding', 'UTF-8', '-cp', $androidJar, '-d', $classes, (Join-Path $source 'MainActivity.java'))
  $classFiles = Get-ChildItem -LiteralPath $classes -Filter '*.class' -Recurse | ForEach-Object FullName
  Invoke-AndroidTool $dex (@('--min-api', '26', '--lib', $androidJar, '--output', $bytecode) + $classFiles)
  Invoke-AndroidTool $jar @('uf', $unsigned, '-C', $bytecode, 'classes.dex')
  Invoke-AndroidTool $align @('-f', '-p', '4', $unsigned, $aligned)

  $keystore = Join-Path $work 'qingcode-android-debug.jks'
  if (-not (Test-Path -LiteralPath $keystore)) {
    Invoke-AndroidTool $keytool @('-genkeypair', '-keystore', $keystore, '-storepass', 'android',
      '-keypass', 'android', '-alias', 'androiddebugkey', '-dname', 'CN=QingCode Development',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000')
  }
  Invoke-AndroidTool $sign @('sign', '--ks', $keystore, '--ks-pass', 'pass:android',
    '--ks-key-alias', 'androiddebugkey', '--out', $signed, $aligned)
  Invoke-AndroidTool $sign @('verify', '--verbose', $signed)
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
