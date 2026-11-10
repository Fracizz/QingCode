//! 标签页列表模型：打开去重、关闭后激活位置调整。与 UI 无关，便于单测。

use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

pub trait TabKey {
    fn path(&self) -> &Path;
}

pub struct Tabs<T> {
    items: Vec<T>,
    active: Option<usize>,
}

impl<T> Default for Tabs<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            active: None,
        }
    }
}

impl<T: TabKey> Tabs<T> {
    pub fn items(&self) -> &[T] {
        &self.items
    }

    /// 可修改各标签内容，但不能增删（保持激活下标一致）。
    pub fn items_mut(&mut self) -> &mut [T] {
        &mut self.items
    }

    pub fn active_index(&self) -> Option<usize> {
        self.active
    }

    pub fn active(&self) -> Option<&T> {
        self.active.and_then(|i| self.items.get(i))
    }

    pub fn position(&self, path: &Path) -> Option<usize> {
        self.items.iter().position(|t| t.path() == path)
    }

    /// 已打开则激活并返回其下标；否则返回 None，由调用方构造后 [`Self::push`]。
    pub fn activate_path(&mut self, path: &Path) -> Option<usize> {
        let ix = self.position(path)?;
        self.active = Some(ix);
        Some(ix)
    }

    /// 在当前标签右侧插入并激活。
    pub fn push(&mut self, item: T) -> usize {
        let ix = match self.active {
            Some(a) => a + 1,
            None => self.items.len(),
        };
        self.items.insert(ix, item);
        self.active = Some(ix);
        ix
    }

    pub fn set_active(&mut self, ix: usize) {
        if ix < self.items.len() {
            self.active = Some(ix);
        }
    }

    /// 关闭指定标签；激活规则同 VS Code：关闭当前页时激活右侧，没有则左侧。
    pub fn close(&mut self, ix: usize) -> Option<T> {
        if ix >= self.items.len() {
            return None;
        }
        let removed = self.items.remove(ix);
        self.active = match self.active {
            _ if self.items.is_empty() => None,
            Some(a) if a > ix => Some(a - 1),
            Some(a) if a == ix => Some(ix.min(self.items.len() - 1)),
            other => other,
        };
        Some(removed)
    }

    #[cfg(test)]
    pub fn paths(&self) -> Vec<PathBuf> {
        self.items.iter().map(|t| t.path().to_path_buf()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct T(PathBuf);
    impl TabKey for T {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    fn tabs(names: &[&str]) -> Tabs<T> {
        let mut t = Tabs::default();
        for n in names {
            t.push(T(PathBuf::from(n)));
        }
        t
    }

    fn names(t: &Tabs<T>) -> Vec<String> {
        t.paths()
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn push_inserts_after_active_and_activates() {
        let mut t = tabs(&["a", "b", "c"]);
        t.set_active(0);
        t.push(T("x".into()));
        assert_eq!(names(&t), ["a", "x", "b", "c"]);
        assert_eq!(t.active_index(), Some(1));
    }

    #[test]
    fn activate_path_dedupes_existing_tabs() {
        let mut t = tabs(&["a", "b"]);
        assert_eq!(t.activate_path(Path::new("a")), Some(0));
        assert_eq!(t.active_index(), Some(0));
        assert_eq!(t.activate_path(Path::new("zz")), None);
    }

    #[test]
    fn close_active_prefers_right_neighbor_then_left() {
        let mut t = tabs(&["a", "b", "c"]);
        t.set_active(1);
        t.close(1);
        assert_eq!(t.active().unwrap().0, PathBuf::from("c"));
        t.close(1);
        assert_eq!(t.active().unwrap().0, PathBuf::from("a"));
        t.close(0);
        assert_eq!(t.active_index(), None);
    }

    #[test]
    fn close_before_active_shifts_active_index() {
        let mut t = tabs(&["a", "b", "c"]);
        t.set_active(2);
        t.close(0);
        assert_eq!(t.active().unwrap().0, PathBuf::from("c"));
        assert!(t.close(9).is_none());
    }
}
