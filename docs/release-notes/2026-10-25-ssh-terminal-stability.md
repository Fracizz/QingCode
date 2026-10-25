# SSH 远程终端长时间稳定性验收记录

日期：2026-10-25

## 代码与本地验证

- P0/P1：主连接保活为 10 秒 × 4（约 40 秒），终端独占连接为 15 秒 × 5（约 75 秒）；直连终端断开事件携带原因并记录连接时长。
- P2：交互式 SSH 终端由 daemon PTY 托管，支持独占 SSH 通道、应用层心跳、按 seq 补发、屏幕快照恢复、输入缓冲与无上限重连。
- P3：持久化终端支持应用重启后接回；连接就绪后可汇总孤儿终端并选择接回或结束。
- 输入写入增加每终端单调序号。应答超时后重发同一序号时，daemon 对已写内容回执 duplicate，不重复写入 PTY。
- `pnpm check`：前端 1149 项、主 Rust crate 318 项通过；qingcode-server 105 + 13 + 1 项通过；fmt、clippy、ESLint 通过。
- `pnpm tauri build --no-bundle`：通过，Linux release 产物成功生成。
- Windows 版 `qingcode-server 0.1.14-beta.3` 交叉构建、运行和 `self-check` 通过。

## 252.107 实测

在 `192.168.252.107`（Windows OpenSSH，端口 28822）的一次性临时目录中完成：

- Windows `qingcode-server` 可启动并输出 `--version`。
- `qingcode-server daemon --detach` 启动成功，pipe/token/日志文件生成。
- 启动 daemon 的原始 SSH 命令退出后，daemon 仍存活；其父进程已退出，说明 Windows Job 脱离路径有效。
- `self-check` 的自身 SHA-256 校验通过。
- 验收目录和临时 daemon 进程已清理。

## 尚未执行

以下项目需要 Windows 安装包和可控断网环境，本轮 Linux 主机缺少 `pwsh` / NSIS，无法完成：

- `pnpm package` 因 `pwsh: not found` 未执行成功，未生成 `release/QingCode-setup.exe`。
- WP-G 的 G1–G16、G18–G22 尚未完成，包括真实 SSH 断线/恢复、opencode 与 codex CLI 长跑、8 小时浸泡、离线关闭、Linux logind 行为和 GUI 截图记录。
- Windows ConPTY 下完整 PTY create/input/attach 的图形终端验收仍待安装包环境执行。

结论：代码层 P0–P3 与本地自动化验证完成；Windows Job 脱离关键风险实测通过；安装包与完整 WP-G 真机验收受当前构建环境阻塞。
