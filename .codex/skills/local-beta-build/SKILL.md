---
name: local-beta-build
description: >-
  拉取最新代码并仅在本机构建新的 QingCode beta 版本（本地打包，不提交、不打标签、不推送、不发布）。
  触发词：本地构建 beta、构建新的 beta 版本、新的 BT 版本、beta 打包、拉取代码然后本地构建、local beta build。
---

# 本地 beta 打包

本技能对应仓库常规发版前流程：先把代码拉到 `test` 分支最新，再把 beta 号 +1，最后用统一 CLI 在本地出包。只做本地动作：**不 commit、不 tag、不 push、不发布 Release**，除非用户另行要求。

本技能是**项目级技能**：唯一事实来源在仓库 `.claude/skills/local-beta-build/`，用 `cs-skills-deploy --project D:\Code\QingCode` 同步到仓库内 `.claude` / `.codex` / `.cursor` / `.agents`。不要同步到 `~/.claude`、`~/.codex`、`~/.cursor`、`~/.agents` 等全局目录，也不要发布到远端技能库。

## 前置检查

- 当前分支应为 `test`（跟踪 `origin/test`），master 通常落后于 test，不要从 master 打包。
- 工具链：pnpm 11.0.8、Node >= 22.12；Rust 与 Android 工具链按 `mobile/README.md`（缺 Android 工具链时 APK 会被跳过，不阻断桌面产物）。
- 工作区里只有 2 个版本号文件（`package.json`、`tauri.conf.json`）的改动是正常的（上次 beta 打包后未提交），不要当成脏改动回滚。

## 1. 拉取代码

```powershell
git fetch --all --prune
git status -sb
git rev-list --left-right --count origin/test...HEAD   # 左=远端独有，右=本地独有
```

- 若落后（左侧非 0）且工作区干净：`git pull --ff-only`。
- 若落后但工作区有版本号改动：先 `git stash push` 再 `git pull --ff-only`，随后**丢弃 stash** 并按第 2 步重新 bump（不要 merge 冲突的版本号）。
- 本地版本号改动只影响打包版本，不阻塞拉取；确认 `git status -sb` 与 `origin/test` 同步后再继续。

## 2. 提升版本号

读取 `package.json` 的 `version`（形如 `0.1.18-beta.18`），beta 序号 +1（→ `0.1.18-beta.19`）。必须同步修改：

| 文件 | 位置 |
| --- | --- |
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |

可直接用 `pnpm bump:version <版本>`。**不要**改 `src-tauri/Cargo.toml`、`qingcode-server/Cargo.toml`、`Cargo.lock` 的版本：
它们固定为 `0.0.0`，Rust 侧版本由 build.rs 从 `tauri.conf.json` 读取；bump Cargo 版本会换新的 crate 哈希，增量缓存作废且旧缓存目录堆积。打包成功后会自动按策略清理 `src-tauri/target` 的增量缓存。

校验无残留旧版本：

```powershell
rg -n "0\.1\.18-beta\.\d+" --glob '!node_modules' --glob '!target' --glob '!release' --glob '!dist'
```

`src/test-pages/`、`scripts/web-tests/` 里的 beta 版本字符串是测试 fixture，不要改。

## 3. 本地打包

```powershell
pnpm package:local                    # 前台：安装版 + Server 离线包 + APK
pnpm package:local start --jobs 3     # 后台：返回 run-id，避免终端阻塞
pnpm package:local status <run-id>    # 查看状态与各阶段日志
pnpm package:local cancel <run-id>    # 取消（--task apk 只取消 APK）
```

- 冷构建 Rust 可能超过 10 分钟：优先 `start` 后台模式，或把输出 tee 到 `.dev/` 下的日志。大型任务不要用默认 2 分钟超时的前台命令。
- 同一工作区只允许一个统一打包任务，不要与其他打包脚本（`pnpm package`、`package:exe` 等）并发。
- 报 `active.lock` 时，先确认其中的 PID 与 Cargo/Java 子进程已退出再删除锁。
- `release/` 每次成功打包后只保留最近 3 个语义化版本，属正常清理。

## 4. 验收与汇报

```powershell
Get-ChildItem release | Sort-Object LastWriteTime -Descending | Select-Object -First 8 Name,Length,LastWriteTime
```

- 成功依据是**本次时间戳**的 `release/QingCode_<版本>-setup.exe`、`release/QingCode-servers.zip`、`release/QingCode_<版本>-android.apk` + `release/QingCode-Android.apk`；失败/取消阶段的旧文件不算产物。
- 汇报内容：拉取结果（是否有新提交、是否 up to date）、新版本号、各产物路径与大小/时间；APK 因缺工具链跳过时必须明确说明。
- 不要运行 `pnpm smoke:start`：它针对无版本号的 `release/QingCode.exe`，本地 beta 打包不生成该别名。
- 结束后版本号改动仍未提交，告知用户并等待是否提交（提交信息格式：`chore: bump version to <版本> for local beta build`）。
