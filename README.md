# QingCode

轻量桌面代码编辑器：单窗口多项目、多终端、低内存占用。

基于 Tauri 2 + React + TypeScript + CodeMirror 6。

## 开发

```bash
pnpm install
pnpm tauri:dev
```

Windows 下若 `cargo` 不在 PATH，可用 `pnpm tauri:dev`（会自动加入 `%USERPROFILE%\.cargo\bin`）。

## 构建

```bash
pnpm tauri build
```
