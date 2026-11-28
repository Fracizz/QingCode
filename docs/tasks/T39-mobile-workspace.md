# T39 移动端工作台与会话恢复

范围：`apps/mobile/web/src/**`、`apps/mobile/web/vite.config.ts`、`apps/mobile/tsconfig.json`、`apps/mobile/android/**`、`apps/desktop/src/backend/mobile/**`、`apps/desktop/src/backend/registerMobile.ts`、`apps/desktop/src/shared/backendApi.ts` 的移动端接口、桌面设置页的移动连接部分、`packages/server/src/workspace/fs/**` 的项目只读能力及对应协议类型和测试。依据为 `docs/mvp.md` §9–12和 `docs/agent-adapters.md`。界面参考旧版 `origin/master` 33f870ac 的 Android 工作台和设计规范。

1. 隔离各台电脑的会话、游标、模型、额度和草稿。换网、返回前台或重开后恢复当前会话，授权或证书变化时可在原连接重新配对。发送和审批保留可确认的结果。
2. 工作台集中展示会话、项目和连接。会话按项目分组，提供搜索、状态和快速切换。统一弹层、输入、消息菜单和导航的手机交互。
3. 补齐图片、文件引用、相对文件链接及 Claude 用量。项目文件支持只读浏览、文件名搜索和下载。
4. Android 接入系统扫码／配对链接、选图、文件保存和前台恢复。应用更新接受用户配置的直达 HTTPS APK 和本地 APK，校验同包名、同签名及更高版本。手机终端单独启用，只将会话输出回送到已订阅该会话的配对设备。

验收包括移动端与桌面端类型检查、移动端与网关测试、Web 构建、Android 原生测试、双电脑切换与失败恢复。APK 和系统输入、换网、扫码、下载及安装升级走真机验证。
