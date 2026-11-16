& (& {
    function Read-LaunchLine {
        $line = [Text.StringBuilder]::new()
        while ($true) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq [ConsoleKey]::Enter) { break }
            [void]$line.Append($key.KeyChar)
        }
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.ToString()))
    }
    $nonce = $env:QINGCODE_PREWARM_NONCE
    [Environment]::SetEnvironmentVariable('QINGCODE_PREWARM_NONCE', $null, 'Process')
    [Console]::WriteLine("QC-$nonce-ready!")
    try {
        $directory = Read-LaunchLine
        Microsoft.PowerShell.Management\Set-Location -LiteralPath $directory -ErrorAction Stop
    } catch {
        [Console]::WriteLine("QC-$nonce-error!")
        exit 1
    }
    [Console]::WriteLine("QC-$nonce-cwd!")
    $command = Read-LaunchLine
    [Console]::Clear()
    [ScriptBlock]::Create($command)
})
