# Git 多端同步

在一个项目推送后，让 QingCode 中属于同一仓库的其他项目（本地或 SSH）立即快进到最新提交。入口在 **设置 → Git 多端同步**，默认关闭。

这是一个独立的可选功能，代码集中存放，便于整体移除（见文末清单）。

## 工作方式

```
A push → A 的 reflog 追加 “update by push” → 桌面端收到事件
       → 按归一化 remote URL + 分支匹配开启“自动接收”的项目 B
       → B: 读分支跟踪 → fetch <remote> <branch> → 安全检查 → merge --ff-only → 刷新状态和已打开的文件
```

- 事件驱动，没有定时轮询。
- `git fetch` 写入的 reflog 不是 `update by push`，不会形成同步回环。
- 接收项目只响应当前分支上游的推送；其他分支不处理。
- 启动、窗口聚焦、切换到接收项目时各补查一次（2 分钟冷却），用于补上离线期间的更新。

## 延迟优化

- 推送事件先按已知的仓库地址（缓存或已保存的身份）预筛接收项目，其他仓库的项目不会排进队列。
- 判定只读 HEAD 与上游引用（`symbolic-ref` + `for-each-ref %(upstream:track)`），不跑会扫描工作区的 `git status`。
- 只获取当前分支的上游（`git fetch <remote> <branch>`），不拉全部远程分支。
- 同一台机器限制并发：本机 4 个、SSH / WSL 2 个；不同机器之间完全并行，当前项目优先。
- 设置页的仓库识别结果保存在 localStorage，重启后打开设置直接显示上次结果，后台刷新完成后整体替换。

## 安全规则

自动操作只有 `git merge --ff-only`，不会自动合并、变基或贮藏。以下情况只记录并提示：

| 情况 | 结果 |
|------|------|
| 本地与远端分叉 | 已跳过 |
| 项目有未保存的编辑器标签 | 已跳过 |
| 本地改动会被覆盖、合并或变基进行中 | Git 拒绝快进，工作区不变 |
| 项目未信任 | 不处理 |

后台不会触发连接、部署或凭据弹窗。

## 推送检测能力

| 推送来源所在环境 | 终端 / Agent 推送 | SCM 面板推送 |
|------------------|-------------------|--------------|
| 本地项目 | 实时 | 实时 |
| SSH Server 模式 | 实时（需要已部署带 `git.watchPush` 的 Server） | 实时 |
| SSH 兼容模式、端口直连、WSL | 窗口聚焦时补查 | 实时 |

## 已知限制

- 发生推送时 QingCode 需要运行，且来源项目需要已连接。
- 从 QingCode 未连接的机器、CI 或其他人发起的推送没有实时事件，只能在补查时同步。
- fetch 在接收方执行，接收方需要自己的仓库访问凭据。
- reftable 仓库没有 reflog 文件，显示为“仅面板推送”。

## 移除清单

删除以下文件和目录：

- `src/features/gitPushSync/`
- `src/lib/ipc/gitPushSync.ts`
- `src-tauri/src/git_push_sync.rs`
- `src-tauri/src/remote_ssh/server/git_push_sync.rs`
- `src-tauri/qingcode-server/src/git_push_watch.rs`
- `src-tauri/qingcode-server/src/daemon/git_push.rs`
- `docs/git-push-sync.md`

然后移除接入点（均可搜索 `git_push`、`gitPush`、`GitPush`、`GIT_PUSHED_EVENT`）：

- `src-tauri/src/lib.rs`：`mod`、`.manage` 和 4 个命令注册
- `src-tauri/src/remote_ssh.rs`、`src-tauri/src/remote_ssh/server/mod.rs`：模块声明
- `src-tauri/qingcode-server/src/lib.rs`：模块声明
- `src-tauri/qingcode-server/src/proto.rs`：`Event::GitPush`
- `src-tauri/qingcode-server/src/daemon.rs`：能力项、可取消方法、分发、`mod git_push` 和对应测试
- `src/App.tsx`：`useGitPushSync`
- `src/components/SettingsEditor.tsx`、`src/lib/settingsSearch.ts`：设置分组
- `src/lib/ipc/git.ts`：`GIT_PUSHED_EVENT`
- `docs/ssh-workspaces.md`：指向本文的一行
- `src/locales/en.json`、`src/locales/zh-CN.json`：本功能的文案（`pnpm test` 会列出未使用的键）

用户数据只有 SQLite `settings` 表中的 `gitPushSync.config` 一行，残留无副作用。
