# T11 手机版 Web 界面 apps/mobile/web

范围：只改 `apps/mobile/web/**`（Vite + React 19 + Tailwind 4 + zustand + react-markdown，依赖已在 `apps/mobile/package.json`）。可读：`packages/codex-client/src/**`、`apps/desktop/src/shared/backendApi.ts`（目标/项目/事件类型，按需复制类型定义到 `web/src/types.ts`，不要跨包 import desktop）、`apps/desktop/src/backend/mobile/link.ts`（若已存在则复制一份到 `web/src/link.ts`；不存在就按 mvp.md §9.3 自己实现同样的 parse/格式）。

依据：`docs/mvp.md` §9（重点 9.3、9.4）、§6 的对话展示要求。

## 原生桥（与 T12 的约定，写在 `web/src/native.ts`）

```ts
interface QnNative {                       // Android 注入的 window.QnNative，方法都是同步返回请求 id 的字符串 JSON
  request(json: string): string            // {id, method:'probe'|'pair'|'rpc'|'events.open'|'events.close'|'clipboard.read'|'storage.get'|'storage.set', params}
}
// 原生层通过 window.__qnNativeCallback(json) 回调：{id, ok, result|error} 或事件 {stream, event} / {stream, closed, error?}
```
- `probe {host, port}` → `{fingerprint, name, version}`（原生层不校验证书，只返回证书指纹，供首次配对核对）
- `pair {host, port, fp, code, deviceName}` → `{token, desktopName}`（原生层固定 fp）
- `rpc {host, port, fp, token, method, params}` → result
- `events.open {host, port, fp, token}` → 返回 stream id；之后每行事件以 `{stream, event}` 回调；`events.close {stream}`
- `clipboard.read` → 文本；`storage.get/set {key, value?}`（持久化连接列表，含 token；原生层用 Android Keystore 加密存储）
- 浏览器开发模式（无 `window.QnNative`）提供一个 mock 实现（内存假数据），保证 `pnpm --filter @qn/mobile dev` 可在浏览器里点通全部页面。

## 页面

1. 连接列表：每台电脑的名称、地址、状态；"添加连接"→ 粘贴（读剪贴板或手动粘贴文本）→ 解析 → **可编辑表单**（名称、主机、端口、密码；指纹只读）→"测试连接"（probe 并比对 fp，不一致红色警告）→"配对并保存"。连接详情可编辑名称/主机/端口（不重新配对），可删除。
2. 电脑首页：目标列表（本机 + SSH，状态点、连接/断开；密码认证且电脑未保存密码时弹输入框；收到 `hostKey` 相关错误提示"请在电脑上确认主机指纹"）。
3. 项目列表（`projects.list`）→ 会话列表（`thread/list` 按 cwd）→ 对话页：流式 Markdown、推理摘要折叠、命令/文件改动折叠、审批卡片、中断、输入框（IME 组合时 Enter 不发送；手机上默认按钮发送）。复用 `@qn/codex-client` 的 `CodexRpc`、reducer、`approvalResponse`。打开目标对话前 `server.req codex.open` 然后 `codex.attach {sinceSeq}`（server 只向 attach 过的客户端推送）；事件流重连后对已打开目标重新 attach。
4. 深色主题、44px 触控目标、安全区 `env(safe-area-inset-*)`、底部输入框随键盘上移。

## 构建

`web/vite.config.ts`：`base: './'`，输出 `apps/mobile/android/assets/web/`（T12 打进 APK）。

## 验收

`pnpm --filter @qn/mobile typecheck`、`pnpm exec vitest run apps/mobile/web`（link 解析、传输适配、状态逻辑单测）、`pnpm --filter @qn/mobile build:web` 通过。报告列出需要真机验证的交互。

## 补充：Codex 额度（mvp.md §10）

目标卡片显示紧凑额度，对话页顶部可展开详情；逻辑用 `@qn/codex-client` 的 `rateLimits.ts`（T13 实现；若尚不存在，先按 §10 在 web 内实现最小版本，并在报告说明以便合并）。
