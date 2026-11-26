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
| `pair.scan` | `{}` | 打开兼容的系统扫码应用。返回 Next 配对链接或取消时的 `null`。无扫码处理程序时返回 `scanner_unavailable`，仍可用系统相机扫描后打开链接或粘贴导入。 |
| `pair.pending` | `{}` | 读取并消费冷启动接到的配对链接。没有链接时返回 `null`。 |
| `rpc` | `{host, port?, fp, token, method, params?, agent?}` | 透传电脑网关 `/rpc` 的 `result`；`token` 只放 `Authorization` 头 |
| `events.open` | `{host, port?, fp, token}` | 字符串 stream id，例如 `"s1"` |
| `events.close` | `{stream}` | `{closed:true}`；`stream` 也接受 `{stream:"s1"}` |
| `clipboard.read` | `{}` | 剪贴板文本字符串（无内容时 `""`） |
| `clipboard.write` | `{text}` | `{ok:true}`。文本上限 256 Ki UTF-16 字符。 |
| `images.pick` | `{maxCount?, maxBytes?}` | `{images:[{name,mime,dataUrl}], skipped}`。系统选择器支持选取最多四张图，返回的压缩后总字节数不超过 700 KiB。 |
| `download.begin` | `{name,size,mime?}` | 系统保存位置选择器。返回 `{id}` 或取消时的 `null`。文件最长 512 MiB。 |
| `download.append` | `{id,offset,data}` | 顺序追加 base64 分块，解码后每块最多 256 KiB。返回 `{written}` 表示已写字节数。 |
| `download.finish` | `{id}` | 长度核对后将暂存文件写到用户选定位置。返回 `{name}`。 |
| `download.cancel` | `{id}` | 取消指定下载并尝试清理未完成文件，返回 `{ok:true}`。 |
| `updates.status` | `{}` | `{versionName,versionCode,online:true}`。`online` 表示支持用户配置更新地址。 |
| `updates.check` | `{url}` | 从用户填写的直达 HTTPS `.apk` 地址下载、暂存并核对包名和签名。返回 `{available,versionName,versionCode,id?}`，存在新版本时的 `id` 有效期为 15 分钟。 |
| `updates.install` | `{id?}` | 使用已检查更新的 `id`，或在缺省时打开系统选择器读取本地 APK。安装前再次核对包名、签名和更高版本，通过 Android 界面确认。返回 `{started}`。 |
| `storage.get` | `{key}` | 明文字符串或 `null` |
| `storage.set` | `{key, value?}` | `{ok:true}`；省略或 `value:null` 表示删除 |

`port` 缺省为 38500；`host` 支持域名、IPv4、裸 IPv6 或 `[IPv6]`（不支持 IPv6 zone id），也可内嵌端口；同时提供 `port` 参数时以该参数为准。`fp` 接受 64 位十六进制，可带冒号、大小写；`SHA256:` base64 形式不接受。HTTPS 的 `HostnameVerifier` 一律放行，身份只由证书指纹保证，以兼容 frp / IP / 域名。连接超时 8 秒；普通 JSON 请求读超时 30 秒；events 不设读超时，由 20 秒心跳与 60 秒无数据看门狗断开。

`storage.*` 的值用 Android Keystore AES/GCM 密钥加密后存 SharedPreferences；`token` 不会写入日志、URL 或错误正文。

系统选择器可等待最多五分钟。图片仅访问系统选择器返回的内容 URI。更新服务器使用系统 HTTPS 证书验证，地址由用户配置，重定向会提示填写直达地址。授权安装前会打开 Android 对应设置，用户返回后可重试。

Activity 返回前台时调用 `window.__qnResume()`。运行中收到配对深链时调用 `window.__qnPairLink(link)`，返回严格 `true` 后清除待处理链接。页面初始化时调用 `pair.pending` 读取冷启动收到的链接，配对仍由用户确认并核对证书指纹。

## 页面返回键

`window.__qnBack()` 返回严格 `true` 时由页面处理，其他返回值或未定义均退出 Activity；JS 无响应时 1 秒兜底退出。

## 占位页面

T11 的 Vite 产物尚未生成时，`assets/web/index.html` 是构建流程占位页。T11 的 Vite 产物同样输出到 `assets/web/`，构建脚本会递归打包整个目录。
