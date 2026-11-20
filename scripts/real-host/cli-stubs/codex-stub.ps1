# Minimal Codex TUI stand-in for QingCode prewarm acceptance on hosts without Codex.
# Emulates only what the prewarm adapter reads: idle OSC, composer, /pwd and /cd.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$E = [char]27; $Bel = [char]7; $Chev = [char]0x203A; $Dot = [char]0x2022
$log = Join-Path $PSScriptRoot 'codex.log'
Add-Content -LiteralPath $log -Value ("args=[" + ($args -join '|') + "] cwd=" + (Get-Location).Path)
function Show-Prompt {
    [Console]::Write("`r`n$Chev Ask Codex to do anything")
    [Console]::Write("$E]7501;state=idle:app=codex$Bel")
}
[Console]::Write("Codex stub")
Show-Prompt
$buf = ''
while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::Enter) {
        $cmd = $buf; $buf = ''
        [Console]::Write("`r$E[2K")
        if ($cmd -eq '/pwd') {
            [Console]::Write("$Dot Current working directory: " + (Get-Location).Path)
        } elseif ($cmd.StartsWith('/cd ')) {
            Set-Location -LiteralPath $cmd.Substring(4)
            [Console]::Write("$Dot Working directory changed to: " + (Get-Location).Path)
        } elseif ($cmd -eq '/exit') {
            exit 0
        }
        Show-Prompt
        continue
    }
    $buf += $key.KeyChar
    [Console]::Write("`r$E[2K$Chev $buf")
}
