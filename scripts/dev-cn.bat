@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set RUSTUP_DIST_SERVER=https://rsproxy.cn
set RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
set PATH=%PATH%;%USERPROFILE%\.cargo\bin
cd /d D:\Code\QingCode
pnpm tauri:dev:direct
