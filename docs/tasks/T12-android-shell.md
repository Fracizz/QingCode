# T12 Android 原生壳 + 无 Gradle 构建

范围：只改 `apps/mobile/android/**`（Java 源码、`AndroidManifest.xml`、资源、`build-android.ps1`）。参考（只读）：`D:\code\qingcode\mobile\android\*.java`、`D:\code\qingcode\scripts\build-android.ps1`。

工具链（总管已经 10.87 中转下载）：`JAVA_HOME=D:\code\.qn-toolchain\jdk`（JDK 17）、`ANDROID_HOME=D:\code\.qn-toolchain\android-sdk`（`platforms\android-35`、`build-tools\35.0.0`）。不要下载任何东西。

依据：`docs/mvp.md` §9.1、§9.2；原生桥协议见 `docs/tasks/T11-mobile-web.md`「原生桥」一节（两边必须一致）。

## 要做

- 包名 `com.qingcode.next`，minSdk 26，targetSdk 35，应用名"QingCode Next"，图标用简单矢量/纯色 PNG 即可。
- `MainActivity`：全屏 WebView 加载 `WebViewAssetLoader`（`https://appassets.androidplatform.net/assets/web/index.html`）——若不想引入 androidx，可用 `file:///android_asset/web/index.html` 并开启必要设置；禁止 WebView 访问任意外网（`shouldOverrideUrlLoading` 外链交给系统浏览器）；处理返回键（交给页面 `window.__qnBack?.()`，返回 false 时退出）。
- `NativeBridge`（`@JavascriptInterface request(String json)`）：在线程池执行，结果经 `evaluateJavascript("window.__qnNativeCallback(...)")` 回传（注意 JSON 转义）。
  - HTTPS：`HttpsURLConnection` + 自定义 `SSLContext`：TrustManager **只接受** SHA-256(证书 DER) 等于 `fp` 的服务器证书；`HostnameVerifier` 一律放行（身份由指纹保证，支持 IP/域名/frp）。`probe` 用"记录证书但不拒绝"的 TrustManager 取指纹。连接超时 8s，读超时 30s（events 流不设读超时，靠 20s 心跳 + 60s 无数据判定断开）。
  - `events.open`：后台线程逐行读取 NDJSON，回调 `{stream, event}`；断开回调 `{stream, closed:true, error}`。
  - `clipboard.read`；`storage.get/set`：SharedPreferences + Android Keystore（AES/GCM）加密值。
- `build-android.ps1`：aapt2 compile/link → javac（`--release 17`，classpath android.jar）→ d8 → 打包 assets（`assets/web/**`）→ zipalign → apksigner（本地调试签名：首次用 keytool 生成 `apps/mobile/android/.debug.keystore`，已 gitignore）。输出 `apps/mobile/release/QingCode-Next-Android.apk`。版本号取 `apps/mobile/package.json`。
- 更新 `.gitignore`（仅追加 `apps/mobile/android/.debug.keystore`、`apps/mobile/release/`、`apps/mobile/android/build/`）。

## 验收

- `build-android.ps1` 成功产出 APK；`aapt2 dump badging` 显示包名/版本/sdk 正确；`apksigner verify` 通过。
- 先用 T11 产出的 `assets/web`（若 T11 未完成，放一个占位 index.html 验证构建流程，并在报告说明）。
- 无法在真机运行的部分在报告列出，由总管安排真机验收。
