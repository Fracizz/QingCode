# Requires an administrator account on Windows. Uses an isolated binary, state,
# listener and boot task; never changes the user's paired production gateway.
param([Parameter(Mandatory = $true)][string]$ServerBinary)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$directory = Join-Path $env:USERPROFILE ('.qingcode\server\startup-test-' + [Guid]::NewGuid().ToString('N'))
$binary = Join-Path $directory 'qingcode-server-windows-x86_64.exe'
$state = Join-Path $directory 'run'
New-Item -ItemType Directory -Path $directory | Out-Null
Copy-Item -LiteralPath $ServerBinary -Destination $binary
try {
    $probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $probe.Start(); $port = $probe.LocalEndpoint.Port; $probe.Stop()
    & $binary direct --hostname 127.0.0.1 --port $port --state-dir $state --detach | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Test gateway failed to start' }
    $before = & $binary direct-info --state-dir $state | ConvertFrom-Json
    & $binary startup enable --state-dir $state | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Boot task registration failed' }
    $task = Get-ScheduledTask | Where-Object { $_.Actions.Execute -eq $binary }
    if (@($task).Count -ne 1 -or $task.Principal.LogonType -ne 'S4U' -or $task.Principal.RunLevel -ne 'Limited' -or $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskBootTrigger') { throw 'Unexpected boot task configuration' }
    & $binary startup disable --state-dir $state | Out-Null
    if ($LASTEXITCODE -ne 0 -or !(Get-Process -Id $before.pid -ErrorAction SilentlyContinue)) { throw 'Disabling startup stopped the gateway' }
    & $binary startup enable --state-dir $state | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Re-enabling startup failed' }
    Stop-Process -Id $before.pid
    Wait-Process -Id $before.pid -Timeout 10 -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $task.TaskName
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        $after = & $binary direct-info --state-dir $state | ConvertFrom-Json
        if ($after.pid -ne $before.pid -and (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { $ready = $true; break }
    }
    if (!$ready -or $after.certificateSha256 -ne $before.certificateSha256) { throw 'Boot task did not restore the paired gateway' }
    [ordered]@{ result = 'PASS'; taskStartsGateway = $true; pairingPreserved = $true; disablingKeepsGateway = $true; realRebootTested = $false } | ConvertTo-Json -Compress
} finally {
    & $binary startup disable --state-dir $state | Out-Null
    if (Test-Path (Join-Path $state 'direct\endpoint.json')) {
        $info = & $binary direct-info --state-dir $state | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $info.pid)
        if ($process -and $process.ExecutablePath -eq $binary) {
            Stop-Process -Id $info.pid -ErrorAction SilentlyContinue
            Wait-Process -Id $info.pid -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $directory -Recurse -Force
}
