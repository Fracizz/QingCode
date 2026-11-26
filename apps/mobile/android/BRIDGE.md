# Android 原生桥协议（与 T11 约定）

页面加载地址：`https://appassets.androidplatform.net/assets/web/index.html`。原生层用 `shouldInterceptRequest` 把 `/assets/web/**` 映射到 APK 内 `assets/web/**`，所有其他请求返回 403；`http(s)` 外链交给系统浏览器。页面需使用 `viewport-fit=cover` 与 `env(safe-area-inset-*)`。

## 调用

`window.QnNative.request(json: string): string`

页面应在发起首个请求前定义 `window.__qnNativeCallback`。入参：`{id, method, params}`，`id` 原样回传。`request` 立即返回 JSON 字符串确认：

```json
{"id":1,"queued":true}
```

排队失败时返回 `{"id":1,"queued":false,"error":"..."}`。每个成功排队的请求都会异步收到一次 `window.__qnNativeCallback(json)`：

```json
{"id":1,"ok":true,"result":...}
{"id":1,"ok":false,"error":"可读错误","code":"network"}
```

`error` 是字符串，`code` 可选（`fingerprint`、`unauthorized`、`bad_request`、`network`、`protocol`、`storage`、`clipboard`、`server`、`gateway`、`internal` 等）。事件流不占请求 id，另行回调：

```json
{"stream":"s1","event":{"name":"target.state","payload":{...}}}
{"stream":"s1","closed":true,"error":null}
{"stream":"s1","closed":true,"error":"事件流 60 秒无数据，已断开"}
```

## 方法

| method | params | result |
| --- | --- | --- |
| `probe` | `{host, port?}` | `{fingerprint, name, version, desktopName?, protocol?}`，不校验证书，只返回叶子证书 DER 的 SHA-256（64 位小写 hex） |
| `pair` | `{host, port?, fp, code, deviceName?}` | `{token, desktopName}`；按 `fp` 固定证书 |
| `rpc` | `{host, port?, fp, token, method, params?, agent?}` | 透传电脑网关 `/rpc` 的 `result`；`token` 只放 `Authorization` 头 |
| `events.open` | `{host, port?, fp, token}` | 字符串 stream id，例如 `"s1"` |
| `events.close` | `{stream}` | `{closed:true}`；`stream` 也接受 `{stream:"s1"}` |
| `clipboard.read` | `{}` | 剪贴板文本字符串（无内容时 `""`） |
| `storage.get` | `{key}` | 明文字符串或 `null` |
| `storage.set` | `{key, value?}` | `{ok:true}`；省略或 `value:null` 表示删除 |

`port` 缺省为 38500；`host` 支持域名、IPv4、裸 IPv6 或 `[IPv6]`（不支持 IPv6 zone id），也可内嵌端口；同时提供 `port` 参数时以该参数为准。`fp` 接受 64 位十六进制，可带冒号、大小写；`SHA256:` base64 形式不接受。HTTPS 的 `HostnameVerifier` 一律放行，身份只由证书指纹保证，以兼容 frp / IP / 域名。连接超时 8 秒；普通 JSON 请求读超时 30 秒；events 不设读超时，由 20 秒心跳与 60 秒无数据看门狗断开。

`storage.*` 的值用 Android Keystore AES/GCM 密钥加密后存 SharedPreferences；`token` 不会写入日志、URL 或错误正文。

## 页面返回键

`window.__qnBack()` 返回严格 `true` 时由页面处理，其他返回值或未定义均退出 Activity；JS 无响应时 1 秒兜底退出。

## 占位页面

T11 的 Vite 产物尚未生成时，`assets/web/index.html` 是构建流程占位页。T11 的 Vite 产物同样输出到 `assets/web/`，构建脚本会递归打包整个目录。
