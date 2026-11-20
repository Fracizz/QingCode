# Keep the file handle across Codex and app restarts. The coordinator writes the
# verified destination before claiming the PTY. An unclaimed CLI cannot fall
# through to an interactive shell in the anchor directory.
& {
    $path = $env:QINGCODE_CODEX_HANDOFF
    $anchor = $env:QINGCODE_CODEX_ANCHOR
    $agent = $env:QINGCODE_PREWARM_AGENT
    Remove-Item Env:QINGCODE_CODEX_HANDOFF, Env:QINGCODE_CODEX_ANCHOR, Env:QINGCODE_PREWARM_AGENT -ErrorAction SilentlyContinue
    try {
        $file = [IO.File]::Open($path, 'Open', 'Read', [IO.FileShare]'ReadWrite, Delete')
        if ($anchor) {
            # This override is scoped to one process. Quote the directory as a TOML
            # table key, including spaces and dots in the application data path.
            Set-Location -LiteralPath $anchor -ErrorAction Stop
            $info = Get-Item -Force -LiteralPath $anchor -ErrorAction Stop
            if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                @(Get-ChildItem -Force -LiteralPath $anchor -ErrorAction Stop).Count) { exit 1 }
        }
        if ($agent -eq 'codex' -and $anchor) {
            if ($anchor.Contains("'")) {
                $key = ConvertTo-Json -InputObject $anchor -Compress
                if (!$PSNativeCommandArgumentPassing -or $PSNativeCommandArgumentPassing -eq 'Legacy') {
                    $key = $key.Replace('"', '\"')
                }
            } else {
                $key = "'$anchor'"
            }
            & $agent -c "projects={$key={trust_level='trusted'}}"
        } else {
            & $agent
        }
        $reader = [IO.StreamReader]::new($file, [Text.Encoding]::UTF8)
        $destination = $reader.ReadToEnd()
        if (!$destination) { exit 1 }
        Set-Location -LiteralPath $destination -ErrorAction Stop
    } catch {
        exit 1
    } finally {
        if ($file) { $file.Dispose() }
    }
}
