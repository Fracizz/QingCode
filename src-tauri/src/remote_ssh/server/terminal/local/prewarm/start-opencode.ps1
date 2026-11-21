& {
    $ErrorActionPreference = 'Stop'
    $anchor = $env:QINGCODE_CODEX_ANCHOR
    if ($anchor) {
        Remove-Item Env:QINGCODE_CODEX_ANCHOR
        # Create the remote dedicated directory on first use; it is then checked to be an empty non-link.
        if (!(Test-Path -LiteralPath $anchor)) { New-Item -ItemType Directory -Path $anchor | Out-Null }
        Set-Location -LiteralPath $anchor
        if (((Get-Item -Force -LiteralPath $anchor).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            @(Get-ChildItem -Force -LiteralPath $anchor).Count) { exit 1 }
    }
    $nonce = $env:QINGCODE_PREWARM_NONCE
    Remove-Item Env:QINGCODE_PREWARM_NONCE
    if (!(Get-Command -Name opencode -ErrorAction SilentlyContinue)) {
        [Console]::Write("QC-$nonce-cli_not_installed!")
        exit 1
    }
    $previousUser = $env:OPENCODE_SERVER_USERNAME
    $previousPassword = $env:OPENCODE_SERVER_PASSWORD
    $env:OPENCODE_SERVER_USERNAME = 'qingcode'
    $env:OPENCODE_SERVER_PASSWORD = [Guid]::NewGuid().ToString('N')
    try {
        $job = Start-Job -ArgumentList $PWD.Path -ScriptBlock {
            param($anchor)
            Set-Location -LiteralPath $anchor
            & opencode serve --hostname 127.0.0.1 --port 0 --mdns=false 2>&1
        }
        $url = $null
        while (!$url) {
            foreach ($line in @(Receive-Job $job)) {
                if ("$line" -match '^opencode server listening on (http://127\.0\.0\.1:[0-9]+)$') { $url = $Matches[1] }
            }
            if ($job.State -ne 'Running') { throw 'serve exited' }
            if (!$url) { Start-Sleep -Milliseconds 50 }
        }
        [Console]::Write("QC-$nonce-ready!")
        $encoded = [Console]::ReadLine()
        $directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
        Set-Location -LiteralPath $directory
        $client = New-Object Net.WebClient
        $client.Proxy = $null
        $client.Encoding = [Text.Encoding]::UTF8
        $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("qingcode:$env:OPENCODE_SERVER_PASSWORD"))
        $client.Headers['Authorization'] = "Basic $auth"
        $path = ($client.DownloadString("$url/path?directory=$([Uri]::EscapeDataString($directory))") | ConvertFrom-Json).directory
        if (!$path -or [IO.Path]::GetFullPath($path) -cne [IO.Path]::GetFullPath($PWD.Path)) { throw 'wrong directory' }
        [Console]::Write("QC-$nonce-cwd!")
        & opencode attach $url --dir $PWD.Path
    } catch {
        [Console]::Write("QC-$nonce-error!")
        exit 1
    } finally {
        if ($client) { $client.Dispose() }
        if ($job) { Remove-Job -Force $job }
        $env:OPENCODE_SERVER_USERNAME = $previousUser
        $env:OPENCODE_SERVER_PASSWORD = $previousPassword
    }
}
