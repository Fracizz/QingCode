# Used by the NSIS installer. Force requires prior user confirmation in NSIS.
# All modes are restricted to the executable in this installation.
[CmdletBinding(DefaultParameterSetName = 'Graceful')]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,
  [Parameter(Mandatory = $true, ParameterSetName = 'Check')]
  [switch]$CheckOnly,
  [Parameter(Mandatory = $true, ParameterSetName = 'Force')]
  [switch]$Force,
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
    $modeArguments = @()
    if ($CheckOnly) { $modeArguments += '-CheckOnly' }
    if ($Force) { $modeArguments += '-Force' }
    & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath `
      -ExecutablePath $ExecutablePath -TimeoutSeconds $TimeoutSeconds @modeArguments
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
        if ($CheckOnly) {
          Write-Output 'QingCode executable is locked by another process. Close it, then retry setup.'
          exit 3
        }
        # Wait for a transient image/scan lock, bounded by the same deadline.
      }
    }
    if ($CheckOnly -and $running.Count -gt 0) { exit 2 }

    foreach ($appProcess in $running) {
      if ($Force) {
        try {
          Stop-Process -InputObject $appProcess -Force
        } catch {
          # A process that exited between detection and termination is success.
          if (-not $appProcess.HasExited) { throw }
        }
        continue
      }
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
