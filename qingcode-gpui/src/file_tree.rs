//! 工作区文件树模型：按需加载目录、记录展开状态。
//!
//! 只负责数据；渲染层把 [`Node`] 转换为 gpui-component 的 `TreeItem`。
//! 目录首次展开时才读取磁盘，避免大仓库启动时全量扫描。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 默认隐藏的目录 / 文件名（与 Web 版文件树保持一致的常见噪声目录）。
const HIDDEN_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".dev",
    ".idea",
    ".DS_Store",
    "__pycache__",
];

/// 未加载目录下的占位子节点 id 后缀，用来让 Tree 把它显示为可展开的文件夹。
pub const PLACEHOLDER_SUFFIX: &str = "\u{0}placeholder";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
}

/// 渲染用的树节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    pub expanded: bool,
    pub children: Vec<Node>,
}

/// 目录排序：文件夹在前，再按名称不区分大小写排序。
pub fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

pub fn is_hidden(name: &str) -> bool {
    HIDDEN_NAMES.contains(&name)
}

/// 读取单层目录（不跟随符号链接目录，避免循环与越界）。
pub fn read_dir(dir: &Path) -> std::io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    for item in fs::read_dir(dir)? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        out.push(Entry {
            path: item.path(),
            name,
            is_dir: file_type.is_dir(),
        });
    }
    sort_entries(&mut out);
    Ok(out)
}

/// 路径 → 树节点 id（使用完整路径，保证全局唯一）。
pub fn node_id(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub struct FileTree {
    root: PathBuf,
    loaded: HashMap<PathBuf, Vec<Entry>>,
    expanded: HashSet<PathBuf>,
}

impl FileTree {
    pub fn new(root: PathBuf) -> Self {
        let mut tree = Self {
            root,
            loaded: HashMap::new(),
            expanded: HashSet::new(),
        };
        let root = tree.root.clone();
        tree.ensure_loaded(&root);
        tree
    }

    fn ensure_loaded(&mut self, dir: &Path) {
        if !self.loaded.contains_key(dir) {
            let entries = read_dir(dir).unwrap_or_default();
            self.loaded.insert(dir.to_path_buf(), entries);
        }
    }

    /// 展开目录；返回 true 表示树结构发生变化需要重建。
    pub fn expand(&mut self, dir: &Path) -> bool {
        self.ensure_loaded(dir);
        self.expanded.insert(dir.to_path_buf())
    }

    pub fn collapse(&mut self, dir: &Path) -> bool {
        self.expanded.remove(dir)
    }

    /// 重新读取已加载的目录（例如保存新文件后刷新）。
    pub fn refresh(&mut self) {
        let dirs: Vec<PathBuf> = self.loaded.keys().cloned().collect();
        self.loaded.clear();
        for dir in dirs {
            if dir.is_dir() {
                self.ensure_loaded(&dir);
            } else {
                self.expanded.remove(&dir);
            }
        }
    }

    /// 生成根目录下的节点列表。
    pub fn nodes(&self) -> Vec<Node> {
        self.children_of(&self.root)
    }

    fn children_of(&self, dir: &Path) -> Vec<Node> {
        let Some(entries) = self.loaded.get(dir) else {
            return Vec::new();
        };
        entries
            .iter()
            .map(|entry| {
                let expanded = entry.is_dir && self.expanded.contains(&entry.path);
                let children = if !entry.is_dir {
                    Vec::new()
                } else if self.loaded.contains_key(&entry.path) {
                    self.children_of(&entry.path)
                } else {
                    // 未加载：放一个占位子节点，使其显示为可展开的文件夹
                    vec![Node {
                        id: format!("{}{}", node_id(&entry.path), PLACEHOLDER_SUFFIX),
                        name: "…".into(),
                        is_dir: false,
                        expanded: false,
                        children: Vec::new(),
                    }]
                };
                Node {
                    id: node_id(&entry.path),
                    name: entry.name.clone(),
                    is_dir: entry.is_dir,
                    expanded,
                    children,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, is_dir: bool) -> Entry {
        Entry {
            path: PathBuf::from(name),
            name: name.into(),
            is_dir,
        }
    }

    #[test]
    fn sort_puts_dirs_first_then_case_insensitive_names() {
        let mut v = vec![
            entry("b.rs", false),
            entry("Zeta", true),
            entry("a.rs", false),
            entry("alpha", true),
            entry("B.md", false),
        ];
        sort_entries(&mut v);
        let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["alpha", "Zeta", "a.rs", "B.md", "b.rs"]);
    }

    #[test]
    fn lazy_tree_loads_on_expand_and_hides_noise_dirs() {
        let root = std::env::temp_dir().join(format!("qingcode-gpui-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/inner")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("README.md"), "#").unwrap();

        let mut tree = FileTree::new(root.clone());
        let nodes = tree.nodes();
        let names: Vec<_> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["src", "README.md"]);
        // 未展开的目录带占位子节点
        assert!(nodes[0].is_dir && !nodes[0].expanded);
        assert!(nodes[0].children[0].id.ends_with(PLACEHOLDER_SUFFIX));

        assert!(tree.expand(&root.join("src")));
        let nodes = tree.nodes();
        assert!(nodes[0].expanded);
        let kids: Vec<_> = nodes[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(kids, ["inner", "main.rs"]);

        assert!(tree.collapse(&root.join("src")));
        assert!(!tree.nodes()[0].expanded);

        fs::write(root.join("new.txt"), "").unwrap();
        tree.refresh();
        assert!(tree.nodes().iter().any(|n| n.name == "new.txt"));
        fs::remove_dir_all(&root).unwrap();
    }
}
