//! 主窗口：左侧文件树 + 右侧标签页编辑区（Editor / Diff 切换）+ 底部状态栏。

use std::path::{Path, PathBuf};

use gpui_kit::component::{
    button::{Button, ButtonVariants as _},
    diff::{Diff, DiffFile, DiffMode, DiffState},
    h_flex,
    input::{Editor, EditorState, InputEvent},
    list::ListItem,
    notification::Notification,
    resizable::{h_resizable, resizable_panel},
    tab::{Tab, TabBar},
    tree::{tree, TreeEvent, TreeItem, TreeState},
    v_flex, ActiveTheme as _, Sizable as _, Theme, ThemeMode, WindowExt as _,
};
use gpui_kit::{
    div, px, App, AppContext as _, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, PathPromptOptions,
    Render, SharedString, Styled as _, Subscription, Window,
};

use crate::file_tree::{FileTree, Node, PLACEHOLDER_SUFFIX};
use crate::tabs::{TabKey, Tabs};
use crate::{git, language, text_file};

gpui_kit::actions!(
    qingcode,
    [Save, CloseTab, ToggleDiff, ToggleDiffMode, OpenFolder, Quit]
);

/// 初始化组件库、主题与全局快捷键。应用入口和 UI 测试共用。
pub fn init(cx: &mut App) {
    gpui_kit::init(cx);
    Theme::change(ThemeMode::Dark, None, cx);
    // 全局快捷键（编辑器内部按键由 Input 上下文处理，不冲突）
    cx.bind_keys([
        KeyBinding::new("ctrl-s", Save, None),
        KeyBinding::new("ctrl-w", CloseTab, None),
        KeyBinding::new("ctrl-shift-d", ToggleDiff, None),
        KeyBinding::new("ctrl-shift-m", ToggleDiffMode, None),
        KeyBinding::new("ctrl-o", OpenFolder, None),
        KeyBinding::new("ctrl-q", Quit, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
}

/// 供 UI 测试读取的标签页快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabSnapshot {
    pub path: PathBuf,
    pub dirty: bool,
    pub diff_view: bool,
}

/// 编辑区当前显示内容。
#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Editor,
    Diff,
}

/// 一个打开的文件。
struct Document {
    path: PathBuf,
    editor: Entity<EditorState>,
    /// 原文件是否 CRLF，保存时还原
    crlf: bool,
    dirty: bool,
    view: View,
    diff: Option<Entity<DiffState>>,
    /// Diff 视图提示（无变化 / 不在仓库等）
    diff_note: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

impl TabKey for Document {
    fn path(&self) -> &Path {
        &self.path
    }
}

pub struct QingApp {
    focus: FocusHandle,
    workspace: Option<PathBuf>,
    file_tree: Option<FileTree>,
    tree_state: Entity<TreeState>,
    tabs: Tabs<Document>,
    diff_mode: DiffMode,
    /// 用于在文件树选中变化时只打开一次
    last_tree_selection: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

impl QingApp {
    pub fn new(workspace: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tree_state = cx.new(|cx| TreeState::new(cx));
        let subs = vec![
            cx.subscribe_in(&tree_state, window, Self::on_tree_event),
            cx.observe_in(&tree_state, window, Self::on_tree_changed),
        ];
        let mut this = Self {
            focus: cx.focus_handle(),
            workspace: None,
            file_tree: None,
            tree_state,
            tabs: Tabs::default(),
            diff_mode: DiffMode::Unified,
            last_tree_selection: None,
            _subscriptions: subs,
        };
        if let Some(dir) = workspace {
            this.open_workspace(dir, window, cx);
        }
        this.focus.focus(window, cx);
        this
    }

    // ---------- 测试可观察状态 ----------

    pub fn tree_state(&self) -> &Entity<TreeState> {
        &self.tree_state
    }

    pub fn tab_snapshots(&self) -> Vec<TabSnapshot> {
        self.tabs
            .items()
            .iter()
            .map(|d| TabSnapshot {
                path: d.path.clone(),
                dirty: d.dirty,
                diff_view: d.view == View::Diff,
            })
            .collect()
    }

    pub fn active_index(&self) -> Option<usize> {
        self.tabs.active_index()
    }

    pub fn active_editor(&self) -> Option<Entity<EditorState>> {
        self.tabs.active().map(|d| d.editor.clone())
    }

    pub fn active_diff(&self) -> Option<Entity<DiffState>> {
        self.tabs.active().and_then(|d| d.diff.clone())
    }

    pub fn active_diff_note(&self) -> Option<SharedString> {
        self.tabs.active().and_then(|d| d.diff_note.clone())
    }

    // ---------- 工作区与文件树 ----------

    fn open_workspace(&mut self, dir: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let dir = dunce_like(dir);
        window.set_window_title(&format!(
            "{} — QingCode (GPUI)",
            dir.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| dir.to_string_lossy().into_owned())
        ));
        self.file_tree = Some(FileTree::new(dir.clone()));
        self.workspace = Some(dir);
        self.last_tree_selection = None;
        self.rebuild_tree(cx);
        cx.notify();
    }

    fn rebuild_tree(&mut self, cx: &mut Context<Self>) {
        let items = self
            .file_tree
            .as_ref()
            .map(|t| t.nodes().into_iter().map(to_tree_item).collect::<Vec<_>>())
            .unwrap_or_default();
        let selected = self.last_tree_selection.clone();
        self.tree_state.update(cx, |state, cx| {
            state.set_items(items, cx);
            // set_items 会重置选中，按 id 恢复
            if let Some(id) = selected {
                let ix = state.index_of(&id);
                state.set_selected_index(ix, cx);
            }
        });
    }

    fn on_tree_event(
        &mut self,
        _: &Entity<TreeState>,
        event: &TreeEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tree) = self.file_tree.as_mut() else {
            return;
        };
        let changed = match event {
            TreeEvent::Expanded(id) => tree.expand(Path::new(id.as_ref())),
            TreeEvent::Collapsed(id) => tree.collapse(Path::new(id.as_ref())),
            #[allow(unreachable_patterns)]
            _ => false,
        };
        if changed {
            self.rebuild_tree(cx);
        }
    }

    /// TreeState 没有“选中”事件，通过观察选中项变化来打开文件。
    fn on_tree_changed(
        &mut self,
        state: Entity<TreeState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(item) = state.read(cx).selected_item() else {
            return;
        };
        if item.is_folder() || item.id.ends_with(PLACEHOLDER_SUFFIX) {
            self.last_tree_selection = Some(item.id.clone());
            return;
        }
        if self.last_tree_selection.as_ref() == Some(&item.id) {
            return;
        }
        let id = item.id.clone();
        self.last_tree_selection = Some(id.clone());
        self.open_file(PathBuf::from(id.as_ref()), window, cx);
    }

    // ---------- 标签页 ----------

    fn open_file(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.activate_path(&path).is_some() {
            self.focus_active_editor(window, cx);
            cx.notify();
            return;
        }
        let file = match text_file::read(&path) {
            Ok(f) => f,
            Err(e) => {
                self.notify_error(format!("{}：{e}", display_name(&path)), window, cx);
                return;
            }
        };
        let lang = language::language_for_path(&path);
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language(lang)
                .default_value(file.text)
        });
        let subs = vec![
            cx.subscribe_in(
                &editor,
                window,
                |this, editor, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        if let Some(ix) = this.tabs.items().iter().position(|d| &d.editor == editor)
                        {
                            let doc = &mut this.tabs.items_mut()[ix];
                            doc.dirty = true;
                            // 内容已变，旧 diff 与提示都作废
                            doc.diff = None;
                            doc.diff_note = None;
                            cx.notify();
                        }
                    }
                },
            ),
            // 光标移动等也会 notify，用来刷新状态栏行列号
            cx.observe(&editor, |_, _, cx| cx.notify()),
        ];
        self.tabs.push(Document {
            path,
            editor,
            crlf: file.crlf,
            dirty: false,
            view: View::Editor,
            diff: None,
            diff_note: None,
            _subscriptions: subs,
        });
        self.focus_active_editor(window, cx);
        cx.notify();
    }

    /// 把焦点交给当前编辑器；Diff 视图或无标签时交回根视图，
    /// 否则焦点会停在未渲染的编辑器上，导致全局快捷键无法派发。
    fn focus_active_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.tabs.active() {
            Some(doc) if doc.view == View::Editor => {
                let editor = doc.editor.clone();
                editor.update(cx, |state, cx| state.focus(window, cx));
            }
            _ => self.focus.focus(window, cx),
        }
    }

    fn close_tab(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(doc) = self.tabs.items().get(ix) {
            if doc.dirty {
                // MVP：未保存时不弹确认框，提示后拒绝关闭，避免静默丢失修改
                let name = display_name(&doc.path);
                self.notify_error(
                    format!("{name} 有未保存的修改，请先 Ctrl+S 保存"),
                    window,
                    cx,
                );
                return;
            }
        }
        self.tabs.close(ix);
        self.focus_active_editor(window, cx);
        cx.notify();
    }

    // ---------- 动作 ----------

    fn on_save(&mut self, _: &Save, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.tabs.active_index() else {
            return;
        };
        let (path, text, crlf) = {
            let doc = &self.tabs.items()[ix];
            (
                doc.path.clone(),
                doc.editor.read(cx).value().to_string(),
                doc.crlf,
            )
        };
        match text_file::write(&path, &text, crlf) {
            Ok(()) => {
                let doc = &mut self.tabs.items_mut()[ix];
                doc.dirty = false;
                window.push_notification(
                    Notification::success(format!("已保存 {}", display_name(&path))),
                    cx,
                );
                if let Some(tree) = self.file_tree.as_mut() {
                    tree.refresh();
                }
                self.rebuild_tree(cx);
            }
            Err(e) => self.notify_error(format!("保存失败：{e}"), window, cx),
        }
        cx.notify();
    }

    fn on_close_tab(&mut self, _: &CloseTab, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ix) = self.tabs.active_index() {
            self.close_tab(ix, window, cx);
        }
    }

    fn on_toggle_diff(&mut self, _: &ToggleDiff, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.tabs.active_index() else {
            return;
        };
        let to_diff = self.tabs.items()[ix].view == View::Editor;
        if to_diff {
            self.build_diff(ix, cx);
            self.tabs.items_mut()[ix].view = View::Diff;
        } else {
            self.tabs.items_mut()[ix].view = View::Editor;
        }
        self.focus_active_editor(window, cx);
        cx.notify();
    }

    fn on_toggle_diff_mode(&mut self, _: &ToggleDiffMode, _: &mut Window, cx: &mut Context<Self>) {
        self.diff_mode = match self.diff_mode {
            DiffMode::Unified => DiffMode::Split,
            _ => DiffMode::Unified,
        };
        // DiffState 无 set_mode，清空后按需重建
        for doc in self.tabs.items_mut() {
            doc.diff = None;
        }
        if let Some(ix) = self.tabs.active_index() {
            if self.tabs.items()[ix].view == View::Diff {
                self.build_diff(ix, cx);
            }
        }
        cx.notify();
    }

    fn on_open_folder(&mut self, _: &OpenFolder, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("打开文件夹".into()),
        });
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return;
            };
            let Some(dir) = paths.into_iter().next() else {
                return;
            };
            let _ = window_handle.update(cx, |_, window, cx| {
                let _ = this.update(cx, |this, cx| this.open_workspace(dir, window, cx));
            });
        })
        .detach();
    }

    fn on_quit(&mut self, _: &Quit, _: &mut Window, cx: &mut Context<Self>) {
        cx.quit();
    }

    /// 以 HEAD 为基准、当前缓冲区为修改后版本生成 Diff。
    fn build_diff(&mut self, ix: usize, cx: &mut Context<Self>) {
        if self.tabs.items()[ix].diff.is_some() {
            return;
        }
        let (path, current) = {
            let doc = &self.tabs.items()[ix];
            (doc.path.clone(), doc.editor.read(cx).value().to_string())
        };
        let lang = language::language_for_path(&path);
        let mode = self.diff_mode;
        let result: Result<Option<DiffFile>, String> = (|| {
            let repo = git::find_repo_root(&path).ok_or("文件不在 Git 仓库中")?;
            let rel = git::repo_relative(&repo, &path).ok_or("无法计算仓库相对路径")?;
            let head =
                git::head_content(&repo, &rel).map_err(|e| format!("读取 HEAD 失败：{e}"))?;
            let Some(patch) = git::unified_patch(&rel, head.as_deref(), &current) else {
                return Ok(None);
            };
            let file = DiffFile::parse(&patch)
                .map_err(|e| format!("解析补丁失败：{e:?}"))?
                .into_iter()
                .next()
                .ok_or("补丁为空")?;
            Ok(Some(file.with_language(lang)))
        })();
        let doc = &mut self.tabs.items_mut()[ix];
        match result {
            Ok(Some(file)) => {
                doc.diff = Some(cx.new(|cx| {
                    DiffState::new([file], cx)
                        .with_mode(mode)
                        .with_context_lines(Some(3))
                }));
                doc.diff_note = None;
            }
            Ok(None) => {
                doc.diff = None;
                doc.diff_note = Some("与 HEAD 相比没有变化".into());
            }
            Err(msg) => {
                doc.diff = None;
                doc.diff_note = Some(msg.into());
            }
        }
    }

    fn notify_error(&self, msg: String, window: &mut Window, cx: &mut App) {
        window.push_notification(Notification::error(msg), cx);
    }

    // ---------- 渲染 ----------

    fn render_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let title = self
            .workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_uppercase())
            .unwrap_or_else(|| "未打开文件夹".into());
        v_flex()
            .size_full()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .h(px(32.))
                    .px_3()
                    .justify_between()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(title)
                    .child(
                        Button::new("open-folder")
                            .ghost()
                            .xsmall()
                            .label("打开…")
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(OpenFolder), cx)
                            }),
                    ),
            )
            .child(
                div().flex_1().min_h_0().child(
                    tree(&self.tree_state, |ix, entry, _selected, _window, _cx| {
                        let item = entry.item();
                        let icon = if entry.is_folder() {
                            if entry.is_expanded() {
                                "▾ "
                            } else {
                                "▸ "
                            }
                        } else {
                            "   "
                        };
                        ListItem::new(ix)
                            .pl(px(8. + entry.depth() as f32 * 12.))
                            .child(h_flex().text_sm().child(icon).child(item.label.clone()))
                    })
                    .size_full(),
                ),
            )
    }

    fn render_tab_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.tabs.active_index().unwrap_or(0);
        let tabs = self.tabs.items().iter().enumerate().map(|(ix, doc)| {
            let mut label = display_name(&doc.path);
            if doc.dirty {
                label.push_str(" ●");
            }
            if doc.view == View::Diff {
                label.push_str(" (Diff)");
            }
            Tab::new().label(label).suffix(
                Button::new(("close-tab", ix))
                    .ghost()
                    .xsmall()
                    .label("×")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.close_tab(ix, window, cx);
                    })),
            )
        });
        TabBar::new("editor-tabs")
            .selected_index(active)
            .children(tabs)
            .on_click(cx.listener(|this, ix: &usize, window, cx| {
                this.tabs.set_active(*ix);
                this.focus_active_editor(window, cx);
                cx.notify();
            }))
    }

    fn render_body(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let Some(doc) = self.tabs.active() else {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .text_color(theme.muted_foreground)
                .child("QingCode GPUI 编辑器 MVP")
                .child("Ctrl+O 打开文件夹 · Ctrl+S 保存 · Ctrl+W 关闭标签")
                .child("Ctrl+Shift+D 切换 Diff · Ctrl+Shift+M 切换并排/统一")
                .into_any_element();
        };
        match doc.view {
            View::Editor => div()
                .size_full()
                .child(Editor::new(&doc.editor).bordered(false).size_full())
                .into_any_element(),
            View::Diff => match (&doc.diff, &doc.diff_note) {
                (Some(state), _) => div()
                    .size_full()
                    .child(Diff::new(state).size_full())
                    .into_any_element(),
                (None, note) => v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .text_color(theme.muted_foreground)
                    .child(note.clone().unwrap_or_else(|| "正在生成 Diff…".into()))
                    .into_any_element(),
            },
        }
    }

    fn render_status_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let (left, right) = match self.tabs.active() {
            Some(doc) => {
                let state = doc.editor.read(cx);
                let pos = state.cursor_position();
                let rel = self
                    .workspace
                    .as_ref()
                    .and_then(|w| doc.path.strip_prefix(w).ok())
                    .unwrap_or(&doc.path)
                    .to_string_lossy()
                    .into_owned();
                (
                    rel,
                    format!(
                        "行 {}，列 {}  ·  {}  ·  {}  ·  UTF-8",
                        pos.line + 1,
                        pos.character + 1,
                        state.language_name(),
                        if doc.crlf { "CRLF" } else { "LF" }
                    ),
                )
            }
            None => (String::new(), String::new()),
        };
        h_flex()
            .h(px(24.))
            .px_3()
            .justify_between()
            .text_xs()
            .text_color(theme.muted_foreground)
            .bg(theme.tab_bar)
            .border_t_1()
            .border_color(theme.border)
            .child(left)
            .child(right)
    }
}

impl Focusable for QingApp {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for QingApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 打开 Diff 视图的文档在内容改变后需要按需重建
        if let Some(ix) = self.tabs.active_index() {
            let doc = &self.tabs.items()[ix];
            if doc.view == View::Diff && doc.diff.is_none() && doc.diff_note.is_none() {
                self.build_diff(ix, cx);
            }
        }
        let _ = window;
        let sidebar = self.render_sidebar(cx).into_any_element();
        let tab_bar = self.render_tab_bar(cx).into_any_element();
        let body = self.render_body(cx);
        let status = self.render_status_bar(cx);
        let theme = cx.theme();

        v_flex()
            .id("qingcode-root")
            .key_context("QingCode")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::on_save))
            .on_action(cx.listener(Self::on_close_tab))
            .on_action(cx.listener(Self::on_toggle_diff))
            .on_action(cx.listener(Self::on_toggle_diff_mode))
            .on_action(cx.listener(Self::on_open_folder))
            .on_action(cx.listener(Self::on_quit))
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(
                div().flex_1().min_h_0().child(
                    h_resizable("main-split")
                        .child(
                            resizable_panel()
                                .size(px(260.))
                                .size_range(px(160.)..px(520.))
                                .child(sidebar),
                        )
                        .child(
                            resizable_panel().child(
                                v_flex()
                                    .size_full()
                                    .min_w_0()
                                    .child(tab_bar)
                                    .child(div().flex_1().min_h_0().child(body)),
                            ),
                        ),
                ),
            )
            .child(status)
    }
}

/// 构建 gpui-component 树节点。
fn to_tree_item(node: Node) -> TreeItem {
    TreeItem::new(node.id, node.name)
        .expanded(node.expanded)
        .children(node.children.into_iter().map(to_tree_item))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Windows 下 canonicalize 会得到 `\\?\` 前缀路径，这里去掉以便显示与比较。
fn dunce_like(path: PathBuf) -> PathBuf {
    let abs = path.canonicalize().unwrap_or(path);
    let s = abs.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => abs,
    }
}
