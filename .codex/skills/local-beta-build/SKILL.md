---
name: local-beta-build
description: >-
  拉取最新代码并构建新的 QingCode beta 版本（优先通过 agent-cli-x 在 10.87 的 D:\Code\QingCode 构建，不可用时在本机；不提交、不打标签、不推送、不发布）。
  触发词：本地构建 beta、构建新的 beta 版本、新的 BT 版本、beta 打包、拉取代码然后本地构建、local beta build。
---

# 本地 beta 打包

本技能对应仓库常规发版前流程：先把代码拉到 `test` 分支最新，再把 beta 号 +1，最后用统一 CLI 在本地出包。**日常测试默认不带 `--size-optimized`**（普通 release，增量快）；用户说「正式 beta / 体积优化 / 与 CI 一致 / 发布前验收」时才带（见第 3 步）。只做本地动作：**不 commit、不 tag、不 push、不发布 Release**，除非用户另行要求。

本技能是**项目级技能**：唯一事实来源在仓库 `.claude/skills/local-beta-build/`，用 `cs-skills-deploy --project D:\Code\QingCode` 同步到仓库内 `.claude` / `.codex` / `.cursor` / `.agents`。不要同步到 `~/.claude`、`~/.codex`、`~/.cursor`、`~/.agents` 等全局目录，也不要发布到远端技能库。

## 0. 选择构建机（优先 10.87）

先探测 agent-cli-x 节点 **192.168.10.87**（`windows-91295`）是否可用，可用就在它的 `D:\Code\QingCode` 上执行下文全部步骤；不可用才回退到本机当前仓库。

```powershell
agent-cli-x peer list 10.87          # exit 1 = 未登记 → 回退本机
agent-cli-x info windows-91295       # exit 100/101/106 等 = 不可达/授权问题 → 回退本机，并在汇报里说明原因
agent-cli-x exec windows-91295 --cwd dl: --timeout 120 "Set-Location -LiteralPath 'D:\Code\QingCode'; git status -sb"
```

- 该节点没有指向仓库的 workspace（只有 `dl` / `cdrive`，路径权限只读），所以**不要用 `read`/`edit`/`write` 改仓库文件**：每条命令都用 `exec --cwd dl:`，在命令开头 `Set-Location -LiteralPath 'D:\Code\QingCode'`，改版本号用 `pnpm bump:version <版本>`。
- 每次 `exec` 都是新 Shell，步骤之间不保留目录与环境变量；多行或引号复杂的命令先写本地脚本再 `exec --script`。
- 打包用后台模式：`exec ... "pnpm package:local start --jobs 3"`（正式 beta 追加 `--size-optimized`）拿到 run-id，再用 `exec ... "pnpm package:local status <run-id>"` 轮询（或用 `exec --detach` + `job logs windows-91295 <id> --follow`）。不要用前台长命令占住默认超时。
- 产物留在 10.87 的 `D:\Code\QingCode\release\`，用户未要求时不要拷回本机；汇报里写明是在 10.87 构建，并给出远端路径。
- 耗时记录照常写到**构建机**仓库的 `.dev/beta-build-timings.md`（在 10.87 上用 `exec` 追加）。
- 不要在节点的 `exec` 里再调用 `agent-cli-x`（禁止中转）；遇到 `not allowed to relay` 停止并告知用户。

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
pnpm package:local start --jobs 3                    # 默认（日常测试）：后台普通 release 构建，返回 run-id
pnpm package:local start --jobs 3 --size-optimized   # 正式 beta：后台体积优化构建，与 CI 产物一致
pnpm package:local                                   # 前台：安装版 + Server 离线包 + APK
pnpm package:local status <run-id>                   # 查看状态与各阶段日志
pnpm package:local cancel <run-id>                   # 取消（--task apk 只取消 APK）
```

- **何时带 `--size-optimized`**：默认（「本地构建 beta」「新的 BT 版本」等日常测试）**不带**，走 `[profile.release]`（opt-level 2、codegen-units 16、无 LTO、增量），只改前端或少量 Rust 时通常一两分钟出包；汇报里注明「普通 release，体积比 CI 产物大（安装版约 +19%、Server 离线包约 +25%）」。用户明确说「正式 beta」「体积优化」「与 CI 一致」「发布前验收」或要把包发给别人时才带。
- `--size-optimized` 由统一 CLI 转成 `-SizeOptimized` 转发给 `server` / `installer` 两个 Rust 阶段（`opt-level = "s"` + fat LTO + codegen-units 1、关闭 incremental），产物体积与 CI 发布一致。用 `pnpm package:local --plan --size-optimized` 可先确认参数已转发。
- 体积优化时依赖 crate 的缓存仍可复用，但项目自身 crate 每次全量重编，fat LTO 每次整体重做，下限约 12 分钟（实测 707～930s，`installer` 440～580s 最慢）：**务必用 `start` 后台模式**并轮询 `status`，或把输出 tee 到 `.dev/` 下的日志，不要用默认 2 分钟超时的前台命令。普通 release 也建议用 `start`，首次切换 profile 时依赖要按新设置重编一次。
- 耗时不靠人工计时：`start` 记录的 run-id 里已有 `startedAt` / `finishedAt` 与每个 `tasks[]` 的起止时间，第 4 步据此计算总耗时与分段耗时。只有走前台 `pnpm package:local` 时才需要自己记下开始与结束时间。
- 同一工作区只允许一个统一打包任务，不要与其他打包脚本（`pnpm package`、`package:exe` 等）并发。
- 报 `active.lock` 时，先确认其中的 PID 与 Cargo/Java 子进程已退出再删除锁。
- `release/` 每次成功打包后只保留最近 3 个语义化版本，属正常清理。

## 4. 验收与汇报

```powershell
Get-ChildItem release | Sort-Object LastWriteTime -Descending | Select-Object -First 8 Name,Length,LastWriteTime
```

- 成功依据是**本次时间戳**的 `release/QingCode_<版本>-setup.exe`、`release/QingCode-servers.zip`、`release/QingCode_<版本>-android.apk` + `release/QingCode-Android.apk`；失败/取消阶段的旧文件不算产物。
- 汇报内容：拉取结果（是否有新提交、是否 up to date）、新版本号、**Windows exe 总耗时与 APK 总耗时**、各产物路径与大小/时间；APK 因缺工具链跳过时必须明确说明。
- 不要运行 `pnpm smoke:start`：它针对无版本号的 `release/QingCode.exe`，本地 beta 打包不生成该别名。
- 结束后版本号改动仍未提交，告知用户并等待是否提交（提交信息格式：`chore: bump version to <版本> for local beta build`）。

### 打包耗时记录与汇报

每次打包都必须记录耗时，不能只在回复里凭感觉描述：

1. 取数：`pnpm package:local status <run-id>`。分段耗时按各 `tasks[]` 的 `startedAt` / `finishedAt` 计算（`frontend`、`icons`、`server`、`embed`、`installer`、`apk`）；三个汇总口径都要算：
   - **Windows exe 总耗时** = `installer.finishedAt - run.startedAt`：从开跑到安装版 exe 产物完成，含前置 `frontend` / `icons` / `server` / `embed`（即用户实际等桌面安装版的时间）。
   - **APK 总耗时** = `apk.finishedAt - run.startedAt`：从开跑到 APK 产物完成（与 exe 并行，通常短于 exe）。
   - **全流程总耗时** = `run.finishedAt - run.startedAt`。
   失败或取消时用最后一个时间戳并标注未完成，不要当作成功耗时记录。备注列要写清 `冷构建` / `增量构建` 与 `体积优化 --size-optimized` / `普通 release`；两类耗时差距大，与上一条记录比较时只比同类。
2. 追加一行到 `.dev/beta-build-timings.md`（`.dev` 已在 `.gitignore` 中，只留本地、不提交；文件不存在先写表头；备注列写清 `冷构建` / `增量构建`、失败或取消的阶段、APK 是否因缺工具链跳过；时间用本地时区，同一条记录内格式一致）：

```markdown
| 完成时间 | 版本 | run-id | Windows exe 总耗时 | APK 总耗时 | 全流程总耗时 | 分段耗时 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-21 21:31 | 0.1.19-beta.5 | mwqg1t10-4eeb7544 | 144s | 13s | 144s | frontend 8s / icons 1s / server 42s / embed 1s / installer 100s / apk 12s | 增量构建 |
```
3. 汇报里给出：**Windows exe 总耗时**（桌面安装版从开跑到出包）、APK 总耗时、全流程总耗时、最慢阶段（通常 `installer` 的 Cargo/NSIS 或 `server`）、以及与上一条同类记录的 **Windows exe 总耗时** 差值（例如 `较 beta.4 增量构建 +12s`）。`.dev/beta-build-timings.md` 里没有历史记录时只报本次。
