# Minimal Claude Code TUI stand-in for QingCode prewarm acceptance on hosts without Claude.
# Emulates the folder trust dialog (persisted like ~/.claude.json), the composer and /cd.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$E = [char]27; $Ptr = [char]0x276F; $Hook = [char]0x23BF
$Rule = ([string][char]0x2500) * 40
$log = Join-Path $PSScriptRoot 'claude.log'
$trusted = Join-Path $PSScriptRoot 'claude-trusted.txt'
$cwd = (Get-Location).Path
Add-Content -LiteralPath $log -Value ("start cwd=" + $cwd)
$known = @(); if (Test-Path -LiteralPath $trusted) { $known = @(Get-Content -LiteralPath $trusted) }
if ($known -notcontains $cwd) {
    [Console]::Write("$E[2J$E[H")
    [Console]::Write("Accessing workspace:`r`n`r`n$cwd`r`n`r`n")
    [Console]::Write("Quick safety check: Is this a project you created or one you trust?`r`n`r`n")
    [Console]::Write("$Ptr Yes, I trust this folder`r`n  No, exit`r`n`r`nEnter to confirm · Esc to cancel")
    while ($true) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter) { break }
        if ($key.Key -eq [ConsoleKey]::Escape) { exit 1 }
    }
    Add-Content -LiteralPath $trusted -Value $cwd
    Add-Content -LiteralPath $log -Value ("trusted " + $cwd)
}
$history = New-Object System.Collections.Generic.List[string]
$buf = ''
function Draw {
    [Console]::Write("$E[2J$E[H")
    foreach ($line in $history) { [Console]::Write("$line`r`n") }
    [Console]::Write("$Rule`r`n$Ptr $buf`r`n$Rule")
    if ($buf -eq '/cd') { [Console]::Write("`r`n  /cd    Move this session to a new working directory") }
}
Draw
while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::Enter) {
        $cmd = $buf; $buf = ''
        $history.Add("$Ptr $cmd")
        if ($cmd.StartsWith('/cd ')) {
            $target = $cmd.Substring(4)
            $now = (Get-Location).Path.Replace('\', '/')
            if ($now -eq $target.Replace('\', '/')) {
                $history.Add("  $Hook  Already in $target.")
            } else {
                Set-Location -LiteralPath $target
                $history.Add("  $Hook  Moved to $target")
            }
        } elseif ($cmd -eq '/exit') { exit 0 }
        Draw
        continue
    }
    $buf += $key.KeyChar
    Draw
}
