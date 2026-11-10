//! QingCode GPUI 原生编辑器 MVP。
//!
//! 用法：`qingcode-gpui [工作区目录]`，缺省为当前目录。

// release 构建不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use gpui_kit::{px, size, AppContext as _, Bounds, WindowBounds, WindowOptions};
use qingcode_gpui::app::{self, QingApp};

fn main() {
    let workspace = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| {
            // 便携包双击启动时 cwd 就是 exe 所在目录，此时不自动打开，等用户 Ctrl+O
            let cwd = std::env::current_dir().ok()?;
            let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
            (cwd != exe_dir).then_some(cwd)
        })
        .filter(|p| p.is_dir());

    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            app::init(cx);

            let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, move |window, cx| {
                cx.new(|cx| QingApp::new(workspace.clone(), window, cx))
            })
            .expect("无法打开主窗口（需要交互式桌面会话）");
            cx.activate(true);
        });
}
