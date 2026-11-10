QingCode GPUI 编辑器 MVP（便携版，Windows x64）
==============================================

这是 QingCode 向 GPUI 原生 UI 迁移的试验版本，不需要安装，也不依赖 WebView2。

启动
  - 双击 QingCode-GPUI.exe，按 Ctrl+O 选择要打开的文件夹
  - 或命令行：QingCode-GPUI.exe D:\path\to\workspace

快捷键
  Ctrl+O         打开文件夹
  Ctrl+S         保存（保留原文件 CRLF/LF）
  Ctrl+W         关闭标签（有未保存修改时会拒绝）
  Ctrl+Shift+D   切换 Diff（当前内容 对比 git HEAD，含未保存修改）
  Ctrl+Shift+M   Diff 统一 / 并排
  Ctrl+Q         退出

限制
  - 只支持 UTF-8 文本，单文件 ≤ 5 MB
  - Diff 需要系统已安装 git
  - 暂无 minimap、括号着色、LSP、终端、SSH

试用重点（请反馈）
  1. 微软拼音 / 搜狗输入法的候选框位置与组合输入
  2. 中文、emoji 字体显示是否清晰
  3. 大文件滚动与编辑是否流畅
