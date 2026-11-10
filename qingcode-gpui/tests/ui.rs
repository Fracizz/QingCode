//! 无头窗口 UI 集成测试：用真实组件渲染主窗口，驱动键鼠事件验证 MVP 流程。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use gpui_kit::component::diff::DiffMode;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    base::Root, px, size, AppContext as _, Bounds, Entity, Point, TestAppContext, WindowBounds,
    WindowHandle, WindowOptions,
};
use qingcode_gpui::app::{self, QingApp};

/// 一次性测试工作区：git 仓库内含 LF 与 CRLF 文件和一个子目录。
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("qingcode-gpui-ui-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(
            root.join("a.rs"),
            "fn main() {\n    println!(\"中文\");\n}\n",
        )
        .unwrap();
        fs::write(root.join("crlf.txt"), "one\r\ntwo\r\n").unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn x() {}\n").unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "init",
        ]);
        Self { root }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn open_app(cx: &mut TestAppContext, root: &Path) -> (WindowHandle<Root>, Entity<QingApp>) {
    let root = root.to_path_buf();
    let (handle, view) = cx.update(|cx| {
        app::init(cx);
        let (window, view) = gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Point::default(),
                    size: size(px(1200.), px(800.)),
                })),
                ..Default::default()
            },
            cx,
            move |window, cx| cx.new(|cx| QingApp::new(Some(root), window, cx)),
        )
        .expect("open test window");
        (window.downcast::<Root>().expect("Base Root"), view)
    });
    cx.run_until_parked();
    (handle, view)
}

/// 在文件树中选中某一项（按显示名查找），等价于用户点击该行。
fn select_in_tree(cx: &mut TestAppContext, app: &Entity<QingApp>, path: &Path) {
    let id: gpui_kit::SharedString = path.to_string_lossy().into_owned().into();
    cx.update(|cx| {
        let tree = app.read(cx).tree_state().clone();
        tree.update(cx, |state, cx| {
            let ix = state
                .index_of(&id)
                .unwrap_or_else(|| panic!("{id} 不在文件树中"));
            state.set_selected_index(Some(ix), cx);
        });
    });
    cx.run_until_parked();
}

fn tree_ids(cx: &mut TestAppContext, app: &Entity<QingApp>) -> Vec<String> {
    cx.update(|cx| {
        let tree = app.read(cx).tree_state().clone();
        let state = tree.read(cx);
        (0..)
            .map_while(|ix| state.entry(ix).map(|e| e.item().id.to_string()))
            .collect()
    })
}

fn press(cx: &mut TestAppContext, handle: WindowHandle<Root>, key: &str) {
    cx.update_window(handle.into(), |_, window, cx| window.press(key, cx))
        .unwrap();
    cx.run_until_parked();
}

/// 聚焦当前编辑器并在末尾输入文本。
fn type_at_end(
    cx: &mut TestAppContext,
    handle: WindowHandle<Root>,
    app: &Entity<QingApp>,
    text: &str,
) {
    let editor = cx.update(|cx| app.read(cx).active_editor().expect("有活动编辑器"));
    cx.update_window(handle.into(), |_, window, cx| {
        window.click(("input", editor.entity_id()), cx);
        window.press("ctrl-end", cx);
        window.input(text, cx);
    })
    .unwrap();
    cx.run_until_parked();
}

#[gpui_kit::test]
fn tree_hides_noise_dirs_and_selecting_a_file_opens_an_editor_tab(cx: &mut TestAppContext) {
    let fx = Fixture::new("open");
    let (_handle, app) = open_app(cx, &fx.root);

    let ids = tree_ids(cx, &app);
    assert!(ids.contains(&fx.path("a.rs").to_string_lossy().into_owned()));
    assert!(ids.contains(&fx.path("src").to_string_lossy().into_owned()));
    assert!(!ids.iter().any(|id| id.contains("node_modules")), "{ids:?}");

    select_in_tree(cx, &app, &fx.path("a.rs"));
    cx.update(|cx| {
        let app = app.read(cx);
        let tabs = app.tab_snapshots();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].path, fx.path("a.rs"));
        assert!(!tabs[0].dirty);
        let editor = app.active_editor().unwrap();
        let editor = editor.read(cx);
        assert_eq!(
            editor.value().as_ref(),
            "fn main() {\n    println!(\"中文\");\n}\n"
        );
        assert_eq!(editor.language_name().as_ref(), "rust");
    });

    // 再次选择同一文件不会重复打开
    select_in_tree(cx, &app, &fx.path("crlf.txt"));
    select_in_tree(cx, &app, &fx.path("a.rs"));
    cx.update(|cx| {
        let app = app.read(cx);
        assert_eq!(app.tab_snapshots().len(), 2);
        assert_eq!(
            app.tab_snapshots()[app.active_index().unwrap()].path,
            fx.path("a.rs")
        );
    });
}

#[gpui_kit::test]
fn expanding_a_folder_loads_its_children_lazily(cx: &mut TestAppContext) {
    let fx = Fixture::new("expand");
    let (handle, app) = open_app(cx, &fx.root);
    let child = fx.path("src").join("lib.rs").to_string_lossy().into_owned();
    assert!(!tree_ids(cx, &app).contains(&child));

    // 选中 src 文件夹后按 → 展开（与用户键盘操作一致）
    select_in_tree(cx, &app, &fx.path("src"));
    let tree = cx.update(|cx| app.read(cx).tree_state().clone());
    cx.update_window(handle.into(), |_, window, cx| {
        tree.update(cx, |state, cx| state.focus(window, cx));
    })
    .unwrap();
    press(cx, handle, "right");

    let ids = tree_ids(cx, &app);
    assert!(ids.contains(&child), "{ids:?}");
    // 选中文件夹不会打开标签
    cx.update(|cx| assert!(app.read(cx).tab_snapshots().is_empty()));
}

#[gpui_kit::test]
fn typing_marks_dirty_and_ctrl_s_saves_with_original_crlf(cx: &mut TestAppContext) {
    let fx = Fixture::new("save");
    let (handle, app) = open_app(cx, &fx.root);
    select_in_tree(cx, &app, &fx.path("crlf.txt"));

    type_at_end(cx, handle, &app, "three\n");
    cx.update(|cx| assert!(app.read(cx).tab_snapshots()[0].dirty));

    press(cx, handle, "ctrl-s");
    cx.update(|cx| assert!(!app.read(cx).tab_snapshots()[0].dirty));
    assert_eq!(
        fs::read_to_string(fx.path("crlf.txt")).unwrap(),
        "one\r\ntwo\r\nthree\r\n"
    );
}

#[gpui_kit::test]
fn dirty_tab_refuses_ctrl_w_until_saved(cx: &mut TestAppContext) {
    let fx = Fixture::new("close");
    let (handle, app) = open_app(cx, &fx.root);
    select_in_tree(cx, &app, &fx.path("a.rs"));
    type_at_end(cx, handle, &app, "// edit\n");

    press(cx, handle, "ctrl-w");
    cx.update(|cx| assert_eq!(app.read(cx).tab_snapshots().len(), 1, "未保存时不应关闭"));

    press(cx, handle, "ctrl-s");
    press(cx, handle, "ctrl-w");
    cx.update(|cx| assert!(app.read(cx).tab_snapshots().is_empty()));
}

#[gpui_kit::test]
fn diff_view_compares_unsaved_buffer_with_head(cx: &mut TestAppContext) {
    let fx = Fixture::new("diff");
    let (handle, app) = open_app(cx, &fx.root);
    select_in_tree(cx, &app, &fx.path("a.rs"));

    // 未修改：提示没有变化
    press(cx, handle, "ctrl-shift-d");
    cx.update(|cx| {
        let app = app.read(cx);
        assert!(app.tab_snapshots()[0].diff_view);
        assert!(app.active_diff().is_none());
        assert!(app.active_diff_note().unwrap().contains("没有变化"));
    });

    // 回到编辑器，修改后再看 Diff：基于未保存缓冲区
    press(cx, handle, "ctrl-shift-d");
    type_at_end(cx, handle, &app, "// added line\n");
    press(cx, handle, "ctrl-shift-d");
    cx.update(|cx| {
        let app = app.read(cx);
        let diff = app.active_diff().expect("应生成 Diff");
        let files = diff.read(cx).files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].additions(), 1);
        assert_eq!(files[0].deletions(), 0);
        assert_eq!(files[0].language().as_ref(), "rust");
        assert_eq!(diff.read(cx).mode(), DiffMode::Unified);
    });

    // Diff 视图下快捷键仍可用：切换为并排模式
    press(cx, handle, "ctrl-shift-m");
    cx.update(|cx| {
        let diff = app.read(cx).active_diff().expect("切换模式后重建 Diff");
        assert_eq!(diff.read(cx).mode(), DiffMode::Split);
    });

    // 切回编辑器后可以继续输入
    press(cx, handle, "ctrl-shift-d");
    type_at_end(cx, handle, &app, "// more\n");
    cx.update(|cx| assert!(!app.read(cx).tab_snapshots()[0].diff_view));
    // 磁盘文件未被改动
    assert!(!fs::read_to_string(fx.path("a.rs"))
        .unwrap()
        .contains("added line"));
}
