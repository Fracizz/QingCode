& {
    # pi 没有会话内切换目录的命令：Node 加载器在专用空目录预加载模块，领取时
    # 从 stdin 读目标目录、切换后运行 pi 入口，并把目录写回给退出后的 PowerShell。
    $anchor = $env:QINGCODE_CODEX_ANCHOR
    $nonce = $env:QINGCODE_PREWARM_NONCE
    Remove-Item Env:QINGCODE_CODEX_ANCHOR, Env:QINGCODE_PREWARM_NONCE, Env:QINGCODE_PREWARM_AGENT -ErrorAction SilentlyContinue
    $base = $null
    try {
        if ($anchor) {
            # Create the remote dedicated directory on first use; it is then checked to be an empty non-link.
            if (!(Test-Path -LiteralPath $anchor)) { New-Item -ItemType Directory -Path $anchor -ErrorAction Stop | Out-Null }
            Set-Location -LiteralPath $anchor -ErrorAction Stop
            if ((Get-Item -Force -LiteralPath $anchor -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
            # 清掉此前 CLI 会话留下的空目录（不进入链接）；仍有文件时报告目录被占用，稍后重试。
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
            # Claude Code 运行期间一直在启动目录持有 .claude\scheduled_tasks.lock（已领取的会话也是），只剩它时不算占用。
            $qcLeft = @(Get-ChildItem -Force -LiteralPath $anchor -ErrorAction Stop | Where-Object {
                !($_.Name -eq '.claude' -and $_.PSIsContainer -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                    !@(Get-ChildItem -Force -LiteralPath $_.FullName -ErrorAction Stop | Where-Object Name -ne 'scheduled_tasks.lock').Count)
            })
            if ($qcLeft.Count) {
                [Console]::WriteLine("QC-$nonce-anchor_busy!")
                exit 1
            }
        }
        $pi = Get-Command -Name pi -ErrorAction SilentlyContinue | Select-Object -First 1
        if (!$pi) {
            [Console]::Write("QC-$nonce-cli_not_installed!")
            exit 1
        }
        $node = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($node) {
            $loader = @'
__QINGCODE_PI_PRELOAD__
'@
            $base = Join-Path ([IO.Path]::GetTempPath()) "qingcode-pi-$nonce"
            [IO.File]::WriteAllText("$base.mjs", $loader)
            $env:QC_PI_BIN = $pi.Source
            $env:QC_PI_NONCE = $nonce
            $env:QC_PI_RETURN = "$base.cwd"
            try {
                & $node.Source "$base.mjs"
                $status = $LASTEXITCODE
            } finally {
                Remove-Item Env:QC_PI_BIN, Env:QC_PI_NONCE, Env:QC_PI_RETURN -ErrorAction SilentlyContinue
            }
            $directory = if (Test-Path -LiteralPath "$base.cwd") { [IO.File]::ReadAllText("$base.cwd") }
            if (!$directory) { exit 1 }
            Set-Location -LiteralPath $directory -ErrorAction Stop
            # 75：加载器找不到 pi 的 Node 入口，已切到目标目录，由 PowerShell 普通启动。
            if ($status -eq 75) { & pi }
        } else {
            [Console]::Write("QC-$nonce-ready!")
            $encoded = [Console]::ReadLine()
            $directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
            Set-Location -LiteralPath $directory -ErrorAction Stop
            [Console]::Write("QC-$nonce-cwd!")
            & pi
        }
    } catch [System.Management.Automation.PSSecurityException] {
        [Console]::Write("QC-$nonce-script_blocked!")
        exit 1
    } catch {
        [Console]::Write("QC-$nonce-error!")
        exit 1
    } finally {
        if ($base) { Remove-Item -LiteralPath "$base.mjs", "$base.cwd" -Force -ErrorAction SilentlyContinue }
    }
}
