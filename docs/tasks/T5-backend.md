# T5 Backend：SSH、部署、本机 daemon、server 客户端

范围：只改 `apps/desktop/src/backend/**`（T3 已搭好路由框架与 `targetStore`）。如需改 `src/shared/backendApi.ts`，只允许**新增**字段/方法，并在报告里列出。依赖：`ssh2`（已装）、Node 内置模块、`@qn/protocol`。

依据：`docs/mvp.md` §2、§3.1、§5（逐条实现）。先读：`packages/protocol/src/index.ts`、`packages/server/src/main.ts`（命令行）、`apps/desktop/src/backend/*`、`apps/desktop/src/shared/backendApi.ts`。参考旧项目思路（只读）：`D:\code\qingcode\src-tauri\src\remote_ssh\server\deploy.rs` 模块注释。

## 模块

- `serverClient.ts`：基于 `attachFramedStream` 的 server 客户端：`hello`→`welcome` 握手（超时 10s）、`req` 带 id 的 Promise、`evt` 与 `codex.recv` 回调、`codex.send`、关闭回调。传输无关（接受任意 duplex：ssh2 channel 或 `net.Socket`）。纯逻辑单测（用 PassThrough 模拟 server）。
- `hostKeys.ts`：`userData/known_hosts.json` 读写；`checkHostKey(store, host, port, fingerprint) → 'match'|'new'|'changed'`；指纹格式 `SHA256:<base64 无填充>`（与 OpenSSH 一致，用 ssh2 `hostVerifier` 拿到原始 key 后自行 sha256）。单测。
- `sshTarget.ts`：
  - ssh2 `Client` 连接；认证：密码（`target.connect` 参数传入，不落盘）、私钥文件（可带 passphrase）、agent（Windows 用 `\\.\pipe\openssh-ssh-agent`，失败时提示）；`readyTimeout` 20s；keepalive 15s。
  - `hostVerifier` 异步：`new` / `changed` 时发 `evt hostKey.prompt`，等待 `hostKey.respond`；`changed` 默认拒绝。接受后写入存储。
  - 部署流程（mvp.md §5 第 1–4 步），每步发 `evt target.state`（`deploying` + `detail` 文本，如"检测远端环境""上传 server（1.2 MB）""启动 daemon"）。server 包来自 `resourcesPath/server/qn-server.cjs` 与 `qn-server.json`（`{version, sha256}`）。远端路径中的 `~` 用探测到的 `$HOME` 展开；所有远端命令参数做 POSIX 单引号转义（写成纯函数并单测）。
  - exec 通道 `node '<path>' connect --stdio` → `serverClient` 握手；成功后 `ready`。
  - 断线自动重连：指数退避 1s→30s，用户 `target.disconnect` 后不再重连；重连成功后对已 open 过 codex 的目标自动 `codex.attach {sinceSeq: lastSeq}`（lastSeq 取最近收到的 `codex.recv` 的 seq）。
- `localTarget.ts`：本机：`spawn(electronPath, [qn-server.cjs, 'ensure'], { env: {...process.env, ELECTRON_RUN_AS_NODE:'1'}, windowsHide:true })` 读 stdout JSON 拿 token → `net.connect('\\\\.\\pipe\\qingcode-next-<username>')` → `serverClient`。管道名规则必须与 `packages/server/src/paths.ts` 一致（直接读它的实现，必要时复制同样的算法并在报告里说明）。
- `targets.ts`（管理器）：`id → TargetConnection`，统一 `connect/disconnect/req/codexSend`，把 `codex.recv`、server `evt` 转成 backend 事件（带 `targetId`）。
- 在 `router` 注册：`target.connect`、`target.disconnect`、`hostKey.respond`、`server.req`、`codex.send`。

## 验收

1. `pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run apps/desktop/src/backend` 通过。
2. 集成脚本 `apps/desktop/src/backend/dev/smoke-local.ts`（用 `pnpm exec tsx`不可用时就用 electron-vite 构建后的产物或写成 vitest 用例）：本机 target 连接 → `server.req ping` → `fs.home` 成功。先运行 `pnpm build:server` 生成 `apps/desktop/resources/server/`。
3. 远端 93 的真机验收由总管完成（需要凭据），你只需保证代码路径完整，并提供一个可被总管调用的脚本 `apps/desktop/src/backend/dev/smoke-ssh.ts`：参数 `host port user keyPath`，自动接受新指纹，跑完部署 + ping + fs.home + `codex.open` 并打印结果。

## 补充（总管）

- 方法注册**只写在** `src/backend/registerTargets.ts` 的 `registerTargetMethods(router)` 里，不要改 `src/backend/index.ts`（已接好调用）。事件用 `router.emit(name, payload)`。
- 启动参数从 `src/backend/config.ts` 的 `backendConfig` 取（`userData`、`resourcesPath`、`electronPath`、`appVersion`）。
- T8 并行开发 `projectStore/secretStore/legacy/**`；`target.connect` 需要读取已保存凭据：调用 `secretStore.ts` 导出的 `loadSecret(targetId)` / `saveSecret(targetId, {password?, passphrase?})`（T8 提供；若开发时尚不存在，先在 `sshTarget.ts` 里通过可注入的函数参数解耦，报告里说明）。
- 主机指纹存储放 `src/backend/hostKeys.ts`，导出 `readKnownHosts/writeKnownHosts/checkHostKey/setHostKey`，T8 导入旧指纹时会调用它。
