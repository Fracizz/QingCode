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

## 界面语言

`window.QnNative.setLocale(preference: string): void`

直接同步调用，不经 `request`，没有异步回调。`preference` 取 `'system'`、`'zh'`、`'en'`，其他值忽略。原生层将偏好保存到 SharedPreferences，未设置时按 `system`；`system` 只看系统首选语言，中文（含繁体地区）开头显示中文，否则英文。页面在启动时和用户切换语言后调用。

偏好决定原生层直接显示的文字：通知渠道名、常驻通知和安装结果 Toast，资源位于 `res/values`（英文，默认）与 `res/values-zh`。调用后立即更新已创建的渠道名和运行中的通知。系统选择器与安装确认界面由 Android 按系统语言显示。

回传给页面的 `error` 与事件流提示始终为中文，由页面用 `translateMessage` 翻译。新增或修改提示时同步 `packages/codex-client/src/i18n/android.en.ts`，带变量的提示登记 `{name}` 模板键。电脑网关返回的错误正文原样透传。

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
| `background.get` | `{}` | 本机后台保持连接开关，默认 `true` |
| `background.set` | `{enabled}` | 保存并返回开关值 |
| `background.connection` | `{active}` | 同步当前是否有选中的电脑，返回 `active`。开关开启且有电脑时，由前台 Activity 启动连接服务。 |
| `screen.get` | `{}` | 本机屏幕常亮开关，默认 `false` |
| `screen.set` | `{enabled}` | 保存并返回屏幕常亮开关。应用窗口可见时生效。 |
| `appearance.systemTheme` | `{}` | 返回 Android 当前是否使用浅色主题。系统主题变化时调用 `window.__qnSystemTheme(light)`。 |
| `appearance.systemBars` | `{light}` | 根据 WebView 当前配色设置系统栏，返回 `light`。浅色配色使用深色系统图标。 |
| `clipboard.read` | `{}` | 剪贴板文本字符串（无内容时 `""`） |
| `clipboard.write` | `{text}` | `{ok:true}`。文本上限 256 Ki UTF-16 字符。 |
| `images.pick` | `{maxCount?, maxBytes?, compression?}` | `{images:[{name,mime,dataUrl}], skipped, overLimit, heifUnsupported}`。系统选择器支持选取最多 20 张图，超出 `maxCount` 的张数计入 `overLimit`；返回的压缩后总字节数不超过 700 KiB。`compression` 取 `high`/`medium`（默认）/`low`，对应最长边 1080/1600/2048 与递减的 JPEG 质量；`low` 在体积允许时原样保留 PNG/JPEG/WebP，GIF 始终原样保留。HEIF/HEIC 解码后转成 sRGB JPEG，需 Android 9+，更低版本计入 `heifUnsupported`。 |
| `download.start` | `{host, port?, fp, token, projectId, targetId, path, name, size}` | 原生前台服务经网关 `mobile.files.read` 逐块拉取并直接写入目标文件，应用切后台或页面销毁后继续。Android 10+ 自动保存到「下载/QingCode」，Android 8/9 打开系统保存界面（取消时返回 `null`）。MIME 按扩展名取系统映射，避免文件提供方追加 `.bin`。同一时间只允许一个下载，文件最长 512 MiB。返回状态快照。 |
| `download.status` | `{id?}` | 状态快照 `{id,name,path,size,written,state,auto,error?,savedName?}`，`state` 为 `running`/`done`/`failed`/`cancelled`，`auto` 表示自动保存到下载目录。省略 `id` 时返回最近一次下载，没有时返回 `null`。 |
| `download.cancel` | `{id}` | 取消指定下载并清理未完成文件，返回 `{ok:true}`。通知栏也可取消。 |
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
