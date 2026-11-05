# 移动端协议与验收

## 协议约定

所有 RPC 经固定证书的 HTTPS POST `/v1/rpc` 传输；除配对外均需 Bearer token。响应为 `{ ok: true, data }` 或 `{ ok: false, error }`，HTTP 401 由 Android 桥标记 `revoked`。输入、图片、创建、结束与重命名不自动重发；超时并不等于电脑端未执行。

认证后的 `{ "op": "capabilities" }` 返回：

```json
{
  "protocolVersion": 1,
  "features": ["terminal_profiles", "session_names", "images", "latest_screen", "history"],
  "sessionScope": "shared"
}
```

版本 1 的字段扩展需保持旧客户端行为；功能按 `features` 判断，不用业务写操作探测功能。只有专门的只读能力请求被旧电脑拒绝时使用 legacy 路径；网络或认证失败不能缓存为“不支持”。缓存按地址和证书标识，重新配对后清除。不兼容的协议版本提示更新。

手机会话由所有已配对设备共享，创建者仅决定撤销时的清理范围。图片和文本使用同一共享规则；终端尺寸采用最后一次调整，不承诺多设备独立网格。桌面终端与手机终端继续隔离。

## 自动验证

```powershell
pnpm exec vitest run src/lib/mobileAndroidRequests.test.ts
pnpm test:android-native
cargo test --manifest-path src-tauri/Cargo.toml -p qingcode --lib mobile
pnpm check
pnpm build
```

`test:android-native` 需要 JDK 8+，直接编译生产 `NativeRequests.java`，验证上传不阻塞控制/输出、控制顺序、排队过期不再执行、取消传输与迟到回调、队列上限。无需 Android SDK。Android Release 构建在 JDK 安装后也执行它。

浏览器运行 `pnpm test:web`；Windows / macOS 使用 Ego，Linux 使用 agent-browser。Ego 执行 `scripts/web-tests/mobile-reliability.ego.mjs` 的 `run()`，可传 `spaceId`、`baseUrl`、`artifactDir`，连续回归时传 `finish: false` 并由调用者最终结束同一 TaskSpace。截图和 JSON 结果位于 `.dev/web-tests/mobile-reliability/`。覆盖输入失败后恢复、旧记录保留且不重发、上传时 Ctrl+C、能力协商/旧版兼容，以及 320px、横屏和模拟键盘高度。

浏览器 fixture 不模拟 Android 调度线程；原生队列使用上述 JVM 回归验证。JVM 测试也不能替代 Android TLS、WebView、输入法和系统生命周期。

## Android 设备验收矩阵

每次验收记录 commit/工作区状态、APK SHA-256、签名、系统 API、WebView 版本、设备类型（真机/模拟器）、电脑端版本及项目来源。只读模拟服务、本机 PTY 与远端 SSH / Server 的结果分别记录。

| 场景 | Android 8 / API 26 真机 | 较新 Android 真机 | 模拟器 | 通过条件 |
| --- | --- | --- | --- | --- |
| 安装、覆盖升级、冷启动 | 待执行 | 待执行 | 单独记录 | 配对与草稿保留，无启动崩溃 |
| 扫码、深链、首次配对、证书变化 | 待执行 | 待执行 | 单独记录 | 错误指纹拒绝发送密码；撤销后不能继续认证 |
| 中文组词、多行与补全 | 待执行 | 待执行 | 单独记录 | 组词不提前提交，草稿和实时输入目标明确 |
| 旋转、软键盘、系统栏与返回键 | 待执行 | 待执行 | 单独记录 | 输入栏可见，沉浸恢复，返回按层级处理 |
| PNG/JPEG/HEIC、多选、取消选择 | 待执行 | 待执行 | 单独记录 | 逐张读取，压缩/方向正确，局部失败保留已插入路径 |
| 上传慢速/中断同时 Ctrl+C、结束会话 | 待执行 | 待执行 | 单独记录 | 控制不等待上传，超时结果未知，不自动重发 |
| 后台、杀进程、离线后恢复 | 待执行 | 待执行 | 单独记录 | 接回最新屏幕，未知提交不重发，草稿可恢复 |
| 两台设备接入同一会话、传图、撤销 | 待执行 | 待执行 | 单独记录 | 共享规则一致；创建中撤销后不保留新 PTY |
| 本机 / WSL / SSH / Server | 待执行 | 待执行 | 单独记录 | 项目边界、信任、远端指纹、输入、历史、文件落点分别验证 |

“待执行”不算通过。2026-11-04 实施时 ADB 初始没有物理设备连接；模拟器结果和截图保存在本次 `.dev/` 验收目录，不自动将真机列改为通过。
