//! Path sandbox: native file commands may only touch registered project roots
//! or explicitly authorized paths. Symlinks are resolved via canonicalize
//! before the containment check so a link inside a project cannot escape.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Default)]
pub(crate) struct AllowlistState {
    /// Registered project roots (raw paths from the frontend) — browse/read.
    project_roots: Vec<PathBuf>,
    /// Workspace-trusted roots — write / terminal / spawn_script.
    trusted_roots: Vec<PathBuf>,
    /// Explicit grants (Save As, Open with, temp project dirs, confirmed symlink writes).
    authorized: Vec<PathBuf>,
}

pub struct PathAllowlist {
    inner: Mutex<AllowlistState>,
}

impl PathAllowlist {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AllowlistState::default()),
        }
    }

    pub fn sync_project_roots(&self, roots: Vec<String>) {
        if let Ok(mut state) = self.inner.lock() {
            state.project_roots = roots.into_iter().map(PathBuf::from).collect();
        }
    }

    pub fn sync_trusted_roots(&self, roots: Vec<String>) {
        if let Ok(mut state) = self.inner.lock() {
            state.trusted_roots = roots.into_iter().map(PathBuf::from).collect();
        }
    }

    pub fn authorize_paths(&self, paths: Vec<String>) {
        if let Ok(mut state) = self.inner.lock() {
            for path in paths {
                let buf = PathBuf::from(path);
                if !state.authorized.iter().any(|existing| existing == &buf) {
                    state.authorized.push(buf);
                }
            }
        }
    }

    pub fn ensure_allowed(&self, path: &str) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "路径沙箱状态不可用".to_string())?;
        ensure_path_allowed(Path::new(path), &state)
    }

    /// Read-ok paths that may also be written (trusted workspace, authorized, or app settings).
    pub fn ensure_writable(&self, path: &str) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "路径沙箱状态不可用".to_string())?;
        ensure_path_writable(Path::new(path), &state)
    }

    /// Terminal / spawn_script cwd must sit under a trusted project root.
    pub fn ensure_executable(&self, path: &str) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "路径沙箱状态不可用".to_string())?;
        ensure_path_executable(Path::new(path), &state)
    }

    pub fn with_state<R>(&self, f: impl FnOnce(&AllowlistState) -> R) -> Result<R, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "路径沙箱状态不可用".to_string())?;
        Ok(f(&state))
    }
}

/// Reject relative paths and filesystem roots; require project root or authorization.
pub(crate) fn ensure_path_allowed(path: &Path, state: &AllowlistState) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("仅允许访问绝对路径".to_string());
    }
    if path.parent().is_none() {
        return Err("不允许访问文件系统根目录".to_string());
    }

    let resolved =
        resolve_for_sandbox(path).ok_or_else(|| format!("无法解析路径: {}", display_path(path)))?;

    if is_under_app_settings_dir(&resolved) {
        return Ok(());
    }

    if is_inside_any_root(&resolved, &state.project_roots) {
        return Ok(());
    }

    if is_authorized(&resolved, path, &state.authorized) {
        return Ok(());
    }

    Err(format!(
        "路径不在已注册项目内，且未经授权: {}",
        display_path(&resolved)
    ))
}

/// Write / create / rename / delete: allowlisted path plus trust (or explicit grant).
pub(crate) fn ensure_path_writable(path: &Path, state: &AllowlistState) -> Result<(), String> {
    ensure_path_allowed(path, state)?;
    let resolved =
        resolve_for_sandbox(path).ok_or_else(|| format!("无法解析路径: {}", display_path(path)))?;

    if is_under_app_settings_dir(&resolved) {
        return Ok(());
    }
    if is_authorized(&resolved, path, &state.authorized) {
        return Ok(());
    }
    if is_inside_any_root(&resolved, &state.trusted_roots) {
        return Ok(());
    }

    Err("项目未信任（受限模式），无法修改文件".to_string())
}

/// Terminal / script execution: cwd must be under a trusted project root.
pub(crate) fn ensure_path_executable(path: &Path, state: &AllowlistState) -> Result<(), String> {
    ensure_path_allowed(path, state)?;
    let resolved =
        resolve_for_sandbox(path).ok_or_else(|| format!("无法解析路径: {}", display_path(path)))?;

    if is_inside_any_root(&resolved, &state.trusted_roots) {
        return Ok(());
    }

    Err("项目未信任（受限模式），无法运行终端或脚本".to_string())
}

/// Canonicalize when possible; for not-yet-created paths, walk up to the nearest
/// existing ancestor, canonicalize it (following symlinks), then re-join the suffix.
pub fn resolve_for_sandbox(path: &Path) -> Option<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).ok().map(strip_verbatim_prefix);
    }

    let mut suffix = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        let name = current.file_name()?;
        suffix.push(name.to_os_string());
        if !current.pop() || current.as_os_str().is_empty() {
            return None;
        }
        if current.exists() {
            let mut resolved = fs::canonicalize(&current).ok().map(strip_verbatim_prefix)?;
            for part in suffix.into_iter().rev() {
                resolved.push(part);
            }
            return Some(resolved);
        }
    }
}

fn is_inside_any_root(resolved: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        if let Ok(root_canon) = fs::canonicalize(root) {
            let root_canon = strip_verbatim_prefix(root_canon);
            return path_is_within(resolved, &root_canon);
        }
        // canonicalize can flap under AV / sync-disk load; fall back to loose keys.
        path_is_within_loose(resolved, root)
    })
}

fn is_authorized(resolved: &Path, original: &Path, authorized: &[PathBuf]) -> bool {
    authorized.iter().any(|grant| {
        if let Ok(grant_canon) = fs::canonicalize(grant) {
            let grant_canon = strip_verbatim_prefix(grant_canon);
            if path_is_within(resolved, &grant_canon) || resolved == grant_canon {
                return true;
            }
        }
        // Grant may point at a not-yet-created path (e.g. Save As / empty project).
        paths_equal_loose(original, grant) || paths_equal_loose(resolved, grant)
    })
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// Prefix match on normalized keys so a failed canonicalize still hits registered roots.
fn path_is_within_loose(path: &Path, root: &Path) -> bool {
    let path_key = normalize_key(path);
    let root_key = normalize_key(root);
    path_key == root_key || path_key.starts_with(&(root_key + "/"))
}

fn paths_equal_loose(a: &Path, b: &Path) -> bool {
    normalize_key(a) == normalize_key(b)
}

fn normalize_key(path: &Path) -> String {
    let mut s = display_path(path);
    s = s.replace('\\', "/");
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    s
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    raw.to_string()
}

/// App-owned settings directory (global default-settings.json) is always allowed.
fn app_settings_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest.parent().expect("CARGO_MANIFEST_DIR has no parent");
        project_root.join(".dev")
    } else {
        dirs::data_dir()
            .expect("no data dir")
            .join("com.qingcode.app")
    }
}

fn is_under_app_settings_dir(resolved: &Path) -> bool {
    let dir = app_settings_dir();
    if let Ok(canon) = fs::canonicalize(&dir) {
        return path_is_within(resolved, &strip_verbatim_prefix(canon));
    }
    // Directory may not exist yet (first launch).
    if let Some(parent) = dir.parent() {
        if let Ok(parent_canon) = fs::canonicalize(parent) {
            let expected =
                strip_verbatim_prefix(parent_canon).join(dir.file_name().unwrap_or_default());
            return path_is_within(resolved, &expected) || paths_equal_loose(resolved, &dir);
        }
    }
    paths_equal_loose(resolved, &dir)
}

/// Whether writing `path` would follow a symlink (or symlink parent) to a target
/// outside registered project roots. Used for the confirm UI; `write_file` still
/// enforces via [`ensure_path_allowed`] (canonicalize + allowlist).
pub fn outside_symlink_write_target(
    path: &Path,
    state: &AllowlistState,
) -> Result<Option<PathBuf>, String> {
    if !path_involves_symlink(path) {
        return Ok(None);
    }
    let resolved = resolve_for_sandbox(path)
        .ok_or_else(|| format!("无法解析符号链接路径: {}", display_path(path)))?;
    if is_inside_any_root(&resolved, &state.project_roots) {
        return Ok(None);
    }
    if is_under_app_settings_dir(&resolved) {
        return Ok(None);
    }
    Ok(Some(resolved))
}

fn path_involves_symlink(path: &Path) -> bool {
    let mut current = path.to_path_buf();
    loop {
        if fs::symlink_metadata(&current)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            return true;
        }
        if !current.pop() {
            break;
        }
    }
    false
}

#[tauri::command]
pub fn sync_project_roots(roots: Vec<String>, allowlist: State<'_, PathAllowlist>) {
    allowlist.sync_project_roots(roots);
}

#[tauri::command]
pub fn sync_trusted_roots(roots: Vec<String>, allowlist: State<'_, PathAllowlist>) {
    allowlist.sync_trusted_roots(roots);
}

#[tauri::command]
pub fn authorize_paths(paths: Vec<String>, allowlist: State<'_, PathAllowlist>) {
    allowlist.authorize_paths(paths);
}

/// Build a test allowlist state (unit tests only).
#[cfg(test)]
pub(crate) fn test_state(roots: Vec<PathBuf>, authorized: Vec<PathBuf>) -> AllowlistState {
    AllowlistState {
        project_roots: roots,
        trusted_roots: Vec::new(),
        authorized,
    }
}

#[cfg(test)]
pub(crate) fn test_state_with_trust(
    roots: Vec<PathBuf>,
    trusted: Vec<PathBuf>,
    authorized: Vec<PathBuf>,
) -> AllowlistState {
    AllowlistState {
        project_roots: roots,
        trusted_roots: trusted,
        authorized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_base(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("qingcode-path-guard-{label}-{nonce}"))
    }

    #[test]
    fn path_under_project_ok() {
        let base = temp_base("under");
        let project = base.join("project");
        fs::create_dir_all(project.join("src")).unwrap();
        let file = project.join("src/main.rs");
        fs::write(&file, "fn main() {}").unwrap();

        let state = test_state(vec![project.clone()], vec![]);
        assert!(ensure_path_allowed(&file, &state).is_ok());

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn path_outside_project_rejected() {
        let base = temp_base("outside");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, "nope").unwrap();

        let state = test_state(vec![project], vec![]);
        let err = ensure_path_allowed(&secret, &state).unwrap_err();
        assert!(err.contains("未经授权") || err.contains("不在"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn relative_and_root_rejected() {
        let state = test_state(vec![], vec![]);
        assert!(ensure_path_allowed(Path::new("relative.txt"), &state).is_err());

        let temp_dir = std::env::temp_dir();
        let root = temp_dir.ancestors().last().unwrap();
        assert!(ensure_path_allowed(root, &state).is_err());
    }

    #[test]
    fn is_inside_any_root_falls_back_when_canonicalize_fails() {
        // Non-existent registered root → canonicalize fails; loose keys must still match.
        let ghost_root = if cfg!(windows) {
            PathBuf::from(r"Z:\qingcode-ghost-root-that-does-not-exist")
        } else {
            PathBuf::from("/qingcode-ghost-root-that-does-not-exist")
        };
        let child = ghost_root.join("src").join("main.rs");
        assert!(
            is_inside_any_root(&child, &[ghost_root.clone()]),
            "loose fallback should treat child as inside ghost root"
        );
        assert!(path_is_within_loose(&child, &ghost_root));
        assert!(!path_is_within_loose(
            Path::new(if cfg!(windows) {
                r"Z:\qingcode-ghost-root-that-does-not-exist-extra\x"
            } else {
                "/qingcode-ghost-root-that-does-not-exist-extra/x"
            }),
            &ghost_root
        ));
    }

    #[test]
    fn authorized_path_outside_project_ok() {
        let base = temp_base("auth");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let file = outside.join("save-as.txt");
        fs::write(&file, "ok").unwrap();

        let state = test_state(vec![project], vec![file.clone()]);
        assert!(ensure_path_allowed(&file, &state).is_ok());

        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escaping_project_rejected() {
        use std::os::unix::fs::symlink;

        let base = temp_base("symlink");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "secret").unwrap();
        let link = project.join("alias.txt");
        symlink(&target, &link).unwrap();

        let state = test_state(vec![project], vec![]);
        let err = ensure_path_allowed(&link, &state).unwrap_err();
        assert!(err.contains("未经授权") || err.contains("不在"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escaping_allowed_when_authorized() {
        use std::os::unix::fs::symlink;

        let base = temp_base("symlink-auth");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "secret").unwrap();
        let link = project.join("alias.txt");
        symlink(&target, &link).unwrap();

        let state = test_state(vec![project], vec![target.clone()]);
        assert!(ensure_path_allowed(&link, &state).is_ok());

        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn symlink_escaping_project_rejected_windows() {
        use std::os::windows::fs::symlink_file;

        let base = temp_base("symlink-win");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "secret").unwrap();
        let link = project.join("alias.txt");
        if let Err(err) = symlink_file(&target, &link) {
            // Creating symlinks may require Developer Mode / elevation on Windows.
            eprintln!("skip symlink_escaping_project_rejected_windows: {err}");
            let _ = fs::remove_dir_all(base);
            return;
        }

        let state = test_state(vec![project], vec![]);
        let err = ensure_path_allowed(&link, &state).unwrap_err();
        assert!(err.contains("未经授权") || err.contains("不在"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn fail_closed_when_root_missing() {
        let base = temp_base("missing-root");
        let missing_root = base.join("does-not-exist");
        let outside = base.join("outside.txt");
        fs::create_dir_all(&base).unwrap();
        fs::write(&outside, "x").unwrap();

        let state = test_state(vec![missing_root], vec![]);
        // Missing roots must not widen access to unrelated paths (loose prefix still fails).
        let err = ensure_path_allowed(&outside, &state).unwrap_err();
        assert!(err.contains("未经授权") || err.contains("不在"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn outside_symlink_helper_none_for_regular_file() {
        let base = temp_base("sym-helper");
        fs::create_dir_all(&base).unwrap();
        let file = base.join("a.txt");
        fs::write(&file, "ok").unwrap();
        let state = test_state(vec![base.clone()], vec![]);
        assert!(outside_symlink_write_target(&file, &state)
            .unwrap()
            .is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn write_blocked_when_project_not_trusted() {
        let base = temp_base("untrusted-write");
        let project = base.join("project");
        fs::create_dir_all(project.join("src")).unwrap();
        let file = project.join("src/main.rs");
        fs::write(&file, "fn main() {}").unwrap();

        let state = test_state(vec![project.clone()], vec![]);
        assert!(ensure_path_allowed(&file, &state).is_ok());
        let err = ensure_path_writable(&file, &state).unwrap_err();
        assert!(err.contains("受限") || err.contains("未信任"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn write_ok_when_project_trusted() {
        let base = temp_base("trusted-write");
        let project = base.join("project");
        fs::create_dir_all(project.join("src")).unwrap();
        let file = project.join("src/main.rs");
        fs::write(&file, "fn main() {}").unwrap();

        let state = test_state_with_trust(vec![project.clone()], vec![project.clone()], vec![]);
        assert!(ensure_path_writable(&file, &state).is_ok());
        assert!(ensure_path_executable(&project, &state).is_ok());

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn execute_blocked_when_not_trusted() {
        let base = temp_base("untrusted-exec");
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();

        let state = test_state(vec![project.clone()], vec![]);
        let err = ensure_path_executable(&project, &state).unwrap_err();
        assert!(err.contains("受限") || err.contains("未信任"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn authorized_outside_path_writable_without_trust() {
        let base = temp_base("auth-write");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let file = outside.join("save-as.txt");
        fs::write(&file, "ok").unwrap();

        let state = test_state(vec![project], vec![file.clone()]);
        assert!(ensure_path_writable(&file, &state).is_ok());

        fs::remove_dir_all(base).unwrap();
    }
}
