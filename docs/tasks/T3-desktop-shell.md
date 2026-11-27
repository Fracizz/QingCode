# T3 桌面外壳 apps/desktop（骨架）

范围：`apps/desktop/**`，但**不要**实现 `src/backend/` 里的 SSH/部署/本机 daemon 业务（T5 做）和对话 UI（T6 做）；本任务只搭骨架和通信。不改 `apps/desktop/package.json`（依赖已装：electron 45、electron-vite 6、vite 8、@vitejs/plugin-react、react 19、tailwindcss 4 + @tailwindcss/vite、zustand、lucide-react、react-markdown、remark-gfm、ssh2、electron-builder）。

依据：`docs/mvp.md` §2、§5、§7。

## 要做

1. `electron.vite.config.ts`：main 两个入口 `src/main/index.ts`、`src/backend/index.ts`（输出 `out/main/index.js`、`out/main/backend.js`），preload `src/preload/index.ts`，renderer `src/renderer/`（React + Tailwind 4）。workspace 包 `@qn/protocol`、`@qn/codex-client` 是 TS 源码，需被打包进去（不要 externalize）；`ssh2` 保持 external。
2. `tsconfig.node.json`（main/preload/backend/shared）与 `tsconfig.web.json`（renderer/shared），都 extends `../../tsconfig.base.json`；`package.json` 里的 `typecheck` 脚本已按这两个文件名写好。
3. **共享类型** `src/shared/backendApi.ts`：按 mvp.md §5 定义 `Target`、`SshTargetInput`、`TargetState`、`HostKeyPrompt`、backend 的 req 方法表 `BackendMethods`（params/result）与事件表 `BackendEvents`，以及线消息 `{t:'req',id,method,params} | {t:'res',id,ok,result|error} | {t:'evt',name,payload}`。
4. **main** `src/main/index.ts`：
   - 单实例锁；一个 `BrowserWindow`（1280×800，最小 900×600，`backgroundColor:'#181818'`，系统标题栏即可），`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；`setWindowOpenHandler` 拒绝并 `shell.openExternal`（仅 http/https）；拦截 `will-navigate`。
   - `utilityProcess.fork(out/main/backend.js)`，`serviceName:'qingcode-next-backend'`；用 `MessageChannelMain` 建通道：port1 发给 backend（`child.postMessage({type:'port'}, [port1])`），port2 在窗口 `did-finish-load` 后 `webContents.postMessage('backend-port', null, [port2])`。窗口重载时重新建通道。backend 异常退出时自动重启并重新建通道。
   - 传给 backend 的启动参数/环境：`userData` 路径、`resourcesPath`（开发时为 `apps/desktop/resources`）、Electron 可执行路径（本机 daemon 用）。
   - IPC：`dialog:openFile`（选私钥文件）、`app:version`。
   - `--smoke` 参数：窗口加载完成且渲染进程经 backend 成功调用一次 `targets.list` 后，以退出码 0 退出；30 秒超时退出码 1。渲染进程通过 preload 暴露的 `qn.smokeDone()` 通知 main。
5. **preload** `src/preload/index.ts`：收到 `backend-port` 后 `window.postMessage('qn-backend-port', '*', [port])` 转给页面；`contextBridge.exposeInMainWorld('qn', { openFile, version, smokeDone, isSmoke })`；在 `src/renderer/src/env.d.ts` 声明类型。
6. **backend** `src/backend/index.ts` + `src/backend/router.ts`：接收 port，实现 req/res/evt 路由框架（方法注册表、错误转 `ok:false`、未知方法报错、多次重建 port 时替换）。先实现 `targets.list`（返回本机 + 读 `userData/targets.json`）、`targets.save`、`targets.remove`（存储逻辑放 `src/backend/targetStore.ts`，纯函数部分写单测）。其余方法注册为抛 `not implemented`，留给 T5。
7. **renderer**：`src/renderer/index.html`（CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`；开发模式 electron-vite 会处理 HMR）、`src/renderer/src/main.tsx`、`App.tsx`、`lib/backend.ts`（等待 port → 类型安全的 `call(method, params)` 与 `on(event, cb)`）、`store/targets.ts`（zustand）。布局：左栏目标列表（本机 + SSH，状态点，"添加连接"按钮打开表单：名称/主机/端口/用户/认证方式[密码|私钥文件(用 qn.openFile 选)|ssh-agent]），中栏与主区先放占位。深色主题，CSS 变量写在 `src/renderer/src/styles.css`（Tailwind 4 `@import "tailwindcss"` + `@theme`）。
8. `electron-builder.yml`：appId `com.qingcode.next`，productName `QingCode Next`，win nsis x64，`oneClick:false`、`perMachine:false`、`allowToChangeInstallationDirectory:true`，`extraResources` 把 `resources/server/**` 拷到 `server/`，输出 `release/`，`asarUnpack` 包含 ssh2 的原生可选模块。

## 验收

- `pnpm --filter @qn/desktop typecheck` 通过；`pnpm exec vitest run apps/desktop` 通过。
- `pnpm --filter @qn/desktop build` 成功。
- 在 `apps/desktop` 下运行 `pnpm exec electron . --smoke`（先 build）退出码为 0。
