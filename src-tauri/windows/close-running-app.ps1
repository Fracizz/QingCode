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
  $expectedPath = [IO.Path]::GetFullPath($ExecutablePath)
  $processName = [IO.Path]::GetFileNameWithoutExtension($expectedPath)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $requestedWindows = [Collections.Generic.HashSet[long]]::new()

  do {
    $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object {
      [string]::Equals($_.Path, $expectedPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($running.Count -eq 0) { exit 0 }

    foreach ($appProcess in $running) {
      $appProcess.Refresh()
      $windowHandle = $appProcess.MainWindowHandle.ToInt64()
      if ($windowHandle -ne 0 -and $requestedWindows.Add($windowHandle)) {
        [void]$appProcess.CloseMainWindow()
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  Write-Output 'QingCode is still running. Finish or cancel the save prompt, then retry setup.'
  exit 2
} catch {
  Write-Output $_.Exception.Message
  exit 1
}
