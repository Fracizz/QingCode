# T9 手机网关（电脑 backend）

范围：新增 `apps/desktop/src/backend/mobile/**`；方法注册只写在 `src/backend/registerMobile.ts`；`src/shared/backendApi.ts` 只允许新增 `mobile.*` 类型/方法。依赖：Node 内置模块 + `selfsigned`（已装，生成自签名证书）。凭据加密复用 T8 的 `secretStore.ts`（或其底层的 main `safeStorage` 通道）保存配对密码。

依据：`docs/mvp.md` §9.2、§9.3。

## backend 方法（新增到 BackendMethods）

| method | params | result |
|---|---|---|
| `mobile.getSettings` | — | `{enabled, port, hasPassword, publicAddresses:string[], lanAddresses:string[], fingerprint, running, error?}` |
| `mobile.saveSettings` | `{enabled?, port?, password?, publicAddresses?}` | 同上；保存后按需启停/重启 HTTPS 监听 |
| `mobile.connectionInfo` | `{address}`（`host:port`，来自 lanAddresses 或 publicAddresses） | `{text, link}`（格式见 §9.3，含密码） |
| `mobile.devices` | — | `[{id, name, pairedAt, lastSeenAt, lastIp}]` |
| `mobile.revokeDevice` | `{id}` | — |
| `mobile.regenerateCert` | — | 新 `fingerprint`；同时撤销全部设备 |

## 实现

- `mobile/cert.ts`：首次生成并持久化证书；指纹 = DER SHA-256 小写 hex（纯函数单测）。
- `mobile/pairing.ts`：token 生成与 SHA-256 存储（`userData/mobile/devices.json`）、密码校验（常量时间比较）、按 IP 失败计数锁定（纯逻辑单测）。
- `mobile/gateway.ts`：`https.createServer`；路由 `/probe`、`/pair`、`/rpc`、`/events`（NDJSON，20s 心跳，客户端断开清理）；请求体上限 1 MiB；`/rpc` 白名单严格按 §9.2，调用同一个 `router` 的方法实现（给 router 增加一个内部调用入口，或在网关里持有对 handler 的引用——不要绕开 router 自己重新实现业务）；事件订阅：给 router 增加事件旁路监听（`router.onEmit(cb)`，如需改 `router.ts` 只做这个最小新增并在报告列出）。
- `mobile/link.ts`：`buildPairingLink/buildConnectionInfo/parsePairingLink`（parse 要从任意文本中提取，host 允许 IPv4/IPv6/域名，port 1–65535，fp 64 位 hex）；**同一份 `link.ts` 会被手机端复制使用**，写成无 Node 依赖的纯 TS 并单测。
- 局域网地址：`os.networkInterfaces()` 的非内部 IPv4。
- 设备名默认 `os.hostname()` 作为电脑名。

## 验收

`pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run apps/desktop/src/backend/mobile` 通过；集成测试：在随机端口起网关 → `/probe` → 错误密码被拒且第 6 次锁定 → 正确配对拿 token → `/rpc targets.list` 成功、白名单外方法 403 → `/events` 收到一条 router.emit 的事件 → 撤销设备后 401。客户端测试用 Node `https` + 指纹校验（`checkServerIdentity` 比对指纹）。
