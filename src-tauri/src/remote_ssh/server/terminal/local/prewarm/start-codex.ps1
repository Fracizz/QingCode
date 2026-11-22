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
            # Create the remote dedicated directory on first use; it is then checked to be an empty non-link.
            if (!(Test-Path -LiteralPath $anchor)) { New-Item -ItemType Directory -Path $anchor -ErrorAction Stop | Out-Null }
            Set-Location -LiteralPath $anchor -ErrorAction Stop
            $info = Get-Item -Force -LiteralPath $anchor -ErrorAction Stop
            if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
            # 之前的 CLI 会话可能留下空目录（如 Claude 的 .claude），清掉空目录且不进入链接；
            # 仍有文件（如已领取的会话正在使用）时报告目录被占用，由预热池稍后重试。
            function Remove-QcEmptyDirectory([string]$dir) {
                foreach ($child in @(Get-ChildItem -Force -Directory -LiteralPath $dir -ErrorAction Stop)) {
                    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
                    Remove-QcEmptyDirectory $child.FullName
                    if (!@(Get-ChildItem -Force -LiteralPath $child.FullName -ErrorAction Stop).Count) {
                        Remove-Item -Force -LiteralPath $child.FullName -ErrorAction SilentlyContinue
                    }
                }
            }
            Remove-QcEmptyDirectory $anchor
            if (@(Get-ChildItem -Force -LiteralPath $anchor -ErrorAction Stop).Count) {
                [Console]::WriteLine("QC-${env:QINGCODE_PREWARM_NONCE}-anchor_busy!")
                exit 1
            }
        }
        # CLI 不在 PATH 上时报告「未安装」，预热暂停并提示，而不是笼统地启动失败。
        if (!(Get-Command -Name $agent -ErrorAction SilentlyContinue)) {
            [Console]::WriteLine("QC-${env:QINGCODE_PREWARM_NONCE}-cli_not_installed!")
            exit 1
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
    } catch [System.Management.Automation.PSSecurityException] {
        [Console]::WriteLine("QC-${env:QINGCODE_PREWARM_NONCE}-script_blocked!")
        exit 1
    } catch {
        exit 1
    } finally {
        if ($file) { $file.Dispose() }
    }
}
