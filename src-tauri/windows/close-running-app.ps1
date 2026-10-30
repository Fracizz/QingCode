# Used by the NSIS installer. Never kill the editor or touch another installation.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,
  [ValidateRange(1, 300)]
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
try {
  # NSIS is 32-bit even for an x64/ARM64 app. WOW64 redirects System32 to
  # SysWOW64; Process.Path then returns null for a 64-bit editor. Relaunch
  # natively before enumerating, otherwise a running app looks absent.
  if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    $nativePowerShell = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath `
      -ExecutablePath $ExecutablePath -TimeoutSeconds $TimeoutSeconds
    exit $LASTEXITCODE
  }

  $expectedPath = [IO.Path]::GetFullPath($ExecutablePath)
  $processName = [IO.Path]::GetFileNameWithoutExtension($expectedPath)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $requestedWindows = [Collections.Generic.HashSet[long]]::new()

  do {
    $running = @(foreach ($candidate in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
      $candidate.Refresh()
      if ($candidate.HasExited) { continue }
      $candidatePath = $candidate.Path
      if (-not $candidatePath) {
        if ($candidate.HasExited) { continue }
        throw "Cannot determine executable path for $processName (PID $($candidate.Id)); setup cannot safely continue."
      }
      if ([string]::Equals($candidatePath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        $candidate
      }
    })
    if ($running.Count -eq 0) {
      # Process exit and Windows releasing the executable need not be atomic.
      # Also catch read-only files / other locks before NSIS starts replacing files.
      if (-not (Test-Path -LiteralPath $expectedPath)) { exit 0 }
      try {
        $probe = [IO.File]::Open($expectedPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $probe.Dispose()
        exit 0
      } catch [IO.IOException] {
        # Wait for a transient image/scan lock, bounded by the same deadline.
      }
    }

    foreach ($appProcess in $running) {
      $appProcess.Refresh()
      $windowHandle = $appProcess.MainWindowHandle.ToInt64()
      if ($windowHandle -ne 0 -and $requestedWindows.Add($windowHandle)) {
        [void]$appProcess.CloseMainWindow()
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  Write-Output 'QingCode is still running or its executable is locked. Finish the exit/save prompt, close QingCode, then retry setup.'
  exit 2
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
