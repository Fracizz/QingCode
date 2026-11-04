//! SSH 远端 server 用户私有安装位置的本地持久化缓存。
//!
//! 远端 server 安装在用户私有目录 `~/.qingcode/server/<version>`，每次新连接
//! 都要起一次远端 shell 读家目录并建目录（Windows 上是冷启动 PowerShell）。
//! 这里把「身份 + 主机指纹」对应的家目录与安装目录记在本地应用数据目录的
//! JSON 文件里，跨应用重启复用；命中后调用方仍会做 canonicalize 边界复核。
//!
//! 缓存只用于加速定位，任何读写失败都按「没有缓存」处理，绝不影响远端操作；
//! 所有读-改-写由进程内互斥量串行化，写入采用同目录临时文件 + rename 保证原子性。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// 缓存文件格式版本；与文件内 `version` 不一致时整体视为空表。
const CACHE_VERSION: u32 = 1;

/// 条目上限：超出后按 `updatedAt` 最旧淘汰。
const MAX_ENTRIES: usize = 64;

/// 缓存文件名（位于 [`crate::app_paths::app_data_dir`] 下）。
const CACHE_FILE_NAME: &str = "ssh-server-installs.json";

/// 串行化所有读-改-写，避免多连接并发落盘互相覆盖。
static CACHE_LOCK: Mutex<()> = Mutex::new(());

/// 本机缓存文件的完整路径。
pub(crate) fn install_cache_file() -> PathBuf {
    crate::app_paths::app_data_dir().join(CACHE_FILE_NAME)
}

/// 缓存文件顶层结构：`{"version":1,"entries":{...}}`。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallCacheFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, InstallEntry>,
}

/// 单个身份的安装位置记录。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallEntry {
    #[serde(default)]
    home: String,
    #[serde(default)]
    install_dir: String,
    #[serde(default)]
    server_version: String,
    #[serde(default)]
    updated_at: u64,
}

/// 生成缓存身份键：`username@host:port#fingerprint`。
///
/// 指纹缺失或去空白后为空时返回 `None`（无法确认主机身份，不缓存）；
/// 主机名统一转小写，指纹去首尾空白。
pub(crate) fn identity_key(
    username: &str,
    host: &str,
    port: u16,
    fingerprint: Option<&str>,
) -> Option<String> {
    let fingerprint = fingerprint?.trim();
    if fingerprint.is_empty() {
        return None;
    }
    Some(format!(
        "{username}@{}:{port}#{fingerprint}",
        host.to_lowercase()
    ))
}

fn lock_cache() -> MutexGuard<'static, ()> {
    // 锁中毒只说明此前某次操作 panic；缓存本身没有不变量，继续使用即可。
    CACHE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 远端路径只接受非空且以 `/` 开头的绝对路径。
fn is_valid_remote_path(path: &str) -> bool {
    !path.is_empty() && path.starts_with('/')
}

fn entry_is_valid(entry: &InstallEntry) -> bool {
    is_valid_remote_path(&entry.home) && is_valid_remote_path(&entry.install_dir)
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// 读取缓存表。文件缺失、JSON 损坏或版本不符一律视为空表，绝不 panic。
fn read_table(path: &Path) -> InstallCacheFile {
    let Ok(text) = std::fs::read_to_string(path) else {
        return InstallCacheFile::default();
    };
    match serde_json::from_str::<InstallCacheFile>(&text) {
        Ok(file) if file.version == CACHE_VERSION => file,
        _ => InstallCacheFile::default(),
    }
}

fn load_locked(path: &Path, key: &str, server_version: &str) -> Option<(String, String)> {
    let file = read_table(path);
    let entry = file.entries.get(key)?;
    if entry.server_version != server_version || !entry_is_valid(entry) {
        return None;
    }
    Some((entry.home.clone(), entry.install_dir.clone()))
}

fn store_locked(
    path: &Path,
    key: &str,
    server_version: &str,
    home: &str,
    install_dir: &str,
) -> Result<(), String> {
    if !is_valid_remote_path(home) {
        return Err(format!("家目录必须是非空绝对路径：{home:?}"));
    }
    if !is_valid_remote_path(install_dir) {
        return Err(format!("安装目录必须是非空绝对路径：{install_dir:?}"));
    }

    let mut file = read_table(path);
    file.version = CACHE_VERSION;
    // 顺手清掉历史遗留的非法条目，避免它们一直占用条目额度。
    file.entries.retain(|_, entry| entry_is_valid(entry));
    file.entries.insert(
        key.to_string(),
        InstallEntry {
            home: home.to_string(),
            install_dir: install_dir.to_string(),
            server_version: server_version.to_string(),
            updated_at: now_unix_seconds(),
        },
    );
    evict_oldest(&mut file.entries);
    write_table_atomic(path, &file)
}

fn remove_locked(path: &Path, key: &str) -> Result<(), String> {
    let mut file = read_table(path);
    if file.entries.remove(key).is_none() {
        return Ok(());
    }
    file.version = CACHE_VERSION;
    write_table_atomic(path, &file)
}

/// 超过上限时按 `updatedAt` 升序淘汰；时间相同则按键名保证确定性。
fn evict_oldest(entries: &mut HashMap<String, InstallEntry>) {
    while entries.len() > MAX_ENTRIES {
        let Some(oldest) = entries
            .iter()
            .min_by(|(left_key, left), (right_key, right)| {
                left.updated_at
                    .cmp(&right.updated_at)
                    .then_with(|| left_key.cmp(right_key))
            })
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        entries.remove(&oldest);
    }
}

fn write_temp(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut file =
        std::fs::File::create(path).map_err(|err| format!("创建缓存临时文件失败：{err}"))?;
    file.write_all(data)
        .map_err(|err| format!("写入缓存临时文件失败：{err}"))?;
    file.sync_all()
        .map_err(|err| format!("刷新缓存临时文件失败：{err}"))
}

fn rename_replacing(temp: &Path, target: &Path) -> Result<(), String> {
    match std::fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(first) => {
            // Windows 上目标已存在时 rename 会失败：删掉旧文件再试一次。
            if cfg!(windows) && target.exists() {
                std::fs::remove_file(target).map_err(|err| format!("删除旧缓存文件失败：{err}"))?;
                return std::fs::rename(temp, target)
                    .map_err(|err| format!("写入缓存文件失败：{err}"));
            }
            Err(format!("写入缓存文件失败：{first}"))
        }
    }
}

/// 原子写入：先写同目录 uuid 临时文件，再 rename 覆盖目标。
fn write_table_atomic(path: &Path, file: &InstallCacheFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| format!("创建缓存目录失败：{err}"))?;
        }
    }

    let text =
        serde_json::to_string_pretty(file).map_err(|err| format!("序列化缓存内容失败：{err}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(CACHE_FILE_NAME);
    let temp = path.with_file_name(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    if let Err(err) = write_temp(&temp, text.as_bytes()) {
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }
    if let Err(err) = rename_replacing(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(err);
    }
    Ok(())
}

/// 读取指定路径缓存；版本不符、条目非法或不存在时返回 `None`。
pub(crate) fn load_at(path: &Path, key: &str, server_version: &str) -> Option<(String, String)> {
    let _guard = lock_cache();
    load_locked(path, key, server_version)
}

/// 写入指定路径缓存；路径非法时返回 `Err` 且不写文件。
pub(crate) fn store_at(
    path: &Path,
    key: &str,
    server_version: &str,
    home: &str,
    install_dir: &str,
) -> Result<(), String> {
    let _guard = lock_cache();
    store_locked(path, key, server_version, home, install_dir)
}

/// 删除指定路径缓存中的键；键或文件不存在时返回 `Ok(())`。
pub(crate) fn remove_at(path: &Path, key: &str) -> Result<(), String> {
    let _guard = lock_cache();
    remove_locked(path, key)
}

/// 读取本机缓存。
pub(crate) fn load(key: &str, server_version: &str) -> Option<(String, String)> {
    load_at(&install_cache_file(), key, server_version)
}

/// 写入本机缓存。
pub(crate) fn store(
    key: &str,
    server_version: &str,
    home: &str,
    install_dir: &str,
) -> Result<(), String> {
    store_at(
        &install_cache_file(),
        key,
        server_version,
        home,
        install_dir,
    )
}

/// 删除本机缓存中的键。
pub(crate) fn remove(key: &str) -> Result<(), String> {
    remove_at(&install_cache_file(), key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试临时目录：Drop 时递归清理。
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("qingcode-install-cache-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("创建测试临时目录");
            Self { path }
        }

        fn file(&self) -> PathBuf {
            self.path.join(CACHE_FILE_NAME)
        }

        fn nested_file(&self) -> PathBuf {
            self.path
                .join("nested")
                .join("deeper")
                .join(CACHE_FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn entry(home: &str, install_dir: &str, version: &str, updated_at: u64) -> InstallEntry {
        InstallEntry {
            home: home.to_string(),
            install_dir: install_dir.to_string(),
            server_version: version.to_string(),
            updated_at,
        }
    }

    #[test]
    fn load_missing_file_returns_none_and_store_creates_parent_dirs() {
        let dir = TempDir::new();
        let path = dir.nested_file();

        assert_eq!(load_at(&path, "k", "1.0.0"), None);
        assert!(!path.exists());

        store_at(&path, "k", "1.0.0", "/home/alice", "/home/alice/.qingcode").expect("写入缓存");
        assert_eq!(
            load_at(&path, "k", "1.0.0"),
            Some((
                "/home/alice".to_string(),
                "/home/alice/.qingcode".to_string()
            ))
        );
    }

    #[test]
    fn corrupt_json_or_wrong_version_is_treated_as_empty() {
        let dir = TempDir::new();
        let path = dir.file();

        std::fs::write(&path, "{ this is not json").expect("写入损坏内容");
        assert_eq!(load_at(&path, "k", "1.0.0"), None);

        let wrong_version = r#"{"version":2,"entries":{"k":{"home":"/home/alice","installDir":"/home/alice/.qingcode","serverVersion":"1.0.0","updatedAt":1}}}"#;
        std::fs::write(&path, wrong_version).expect("写入旧版本内容");
        assert_eq!(load_at(&path, "k", "1.0.0"), None);

        store_at(&path, "k", "1.0.0", "/home/bob", "/home/bob/.qingcode").expect("覆盖重建缓存");
        assert_eq!(
            load_at(&path, "k", "1.0.0"),
            Some(("/home/bob".to_string(), "/home/bob/.qingcode".to_string()))
        );
        let parsed: InstallCacheFile =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读取缓存"))
                .expect("缓存应为合法 JSON");
        assert_eq!(parsed.version, CACHE_VERSION);
        assert_eq!(parsed.entries.len(), 1);
    }

    #[test]
    fn server_version_mismatch_returns_none() {
        let dir = TempDir::new();
        let path = dir.file();

        store_at(&path, "k", "1.0.0", "/home/alice", "/home/alice/.qingcode").expect("写入缓存");

        assert_eq!(load_at(&path, "k", "2.0.0"), None);
        assert_eq!(
            load_at(&path, "k", "1.0.0"),
            Some((
                "/home/alice".to_string(),
                "/home/alice/.qingcode".to_string()
            ))
        );
    }

    #[test]
    fn store_rejects_invalid_paths_without_writing() {
        let dir = TempDir::new();
        let path = dir.nested_file();

        for (home, install_dir) in [
            ("", "/opt/qingcode"),
            ("/home/alice", ""),
            ("/home/alice", "opt/qingcode"),
            ("home/alice", "/opt/qingcode"),
        ] {
            assert!(
                store_at(&path, "k", "1.0.0", home, install_dir).is_err(),
                "应拒绝路径 home={home:?} install_dir={install_dir:?}"
            );
        }
        assert!(!path.exists());
        assert!(!dir.path.join("nested").exists());
    }

    #[test]
    fn load_ignores_invalid_entries_on_disk() {
        let dir = TempDir::new();
        let path = dir.file();

        std::fs::write(
            &path,
            r#"{"version":1,"entries":{
                "empty-home":{"home":"","installDir":"/opt/qingcode","serverVersion":"1.0.0","updatedAt":1},
                "relative-install":{"home":"/home/alice","installDir":"opt/qingcode","serverVersion":"1.0.0","updatedAt":2},
                "empty-install":{"home":"/home/alice","installDir":"","serverVersion":"1.0.0","updatedAt":3},
                "relative-home":{"home":"home/alice","installDir":"/opt/qingcode","serverVersion":"1.0.0","updatedAt":4},
                "good":{"home":"/home/alice","installDir":"/opt/qingcode","serverVersion":"1.0.0","updatedAt":5}
            }}"#,
        )
        .expect("写入缓存");

        assert_eq!(load_at(&path, "empty-home", "1.0.0"), None);
        assert_eq!(load_at(&path, "relative-install", "1.0.0"), None);
        assert_eq!(load_at(&path, "empty-install", "1.0.0"), None);
        assert_eq!(load_at(&path, "relative-home", "1.0.0"), None);
        assert_eq!(
            load_at(&path, "good", "1.0.0"),
            Some(("/home/alice".to_string(), "/opt/qingcode".to_string()))
        );
    }

    #[test]
    fn store_overwrites_existing_file_atomically() {
        let dir = TempDir::new();
        let path = dir.file();

        store_at(&path, "k", "1.0.0", "/home/alice", "/home/alice/.qingcode").expect("首次写入");
        store_at(&path, "k", "1.0.0", "/home/alice", "/srv/qingcode").expect("覆盖写入");

        assert_eq!(
            load_at(&path, "k", "1.0.0"),
            Some(("/home/alice".to_string(), "/srv/qingcode".to_string()))
        );

        let names: Vec<String> = std::fs::read_dir(&dir.path)
            .expect("读取测试目录")
            .filter_map(|item| item.ok())
            .map(|item| item.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![CACHE_FILE_NAME.to_string()]);
        assert!(!names.iter().any(|name| name.ends_with(".tmp")));
    }

    #[test]
    fn store_writes_camel_case_json() {
        let dir = TempDir::new();
        let path = dir.file();

        store_at(&path, "k", "1.2.3", "/home/alice", "/home/alice/.qingcode").expect("写入缓存");

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读取缓存"))
                .expect("缓存应为合法 JSON");
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["entries"]["k"]["home"], "/home/alice");
        assert_eq!(
            parsed["entries"]["k"]["installDir"],
            "/home/alice/.qingcode"
        );
        assert_eq!(parsed["entries"]["k"]["serverVersion"], "1.2.3");
        assert!(parsed["entries"]["k"]["updatedAt"].is_u64());
    }

    #[test]
    fn entries_are_capped_with_oldest_evicted() {
        let dir = TempDir::new();
        let path = dir.file();

        let mut file = InstallCacheFile {
            version: CACHE_VERSION,
            entries: HashMap::new(),
        };
        for index in 1..=MAX_ENTRIES as u64 {
            file.entries.insert(
                format!("k{index:02}"),
                entry(
                    &format!("/home/u{index}"),
                    &format!("/home/u{index}/.qingcode"),
                    "1.0.0",
                    index,
                ),
            );
        }
        std::fs::write(&path, serde_json::to_vec(&file).expect("序列化")).expect("写入缓存");

        store_at(&path, "new", "1.0.0", "/home/new", "/home/new/.qingcode").expect("写入新条目");

        let parsed: InstallCacheFile =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读取缓存"))
                .expect("缓存应为合法 JSON");
        assert_eq!(parsed.entries.len(), MAX_ENTRIES);
        assert!(!parsed.entries.contains_key("k01"), "最旧条目应被淘汰");
        assert!(parsed.entries.contains_key("new"));
    }

    #[test]
    fn remove_missing_key_or_file_is_ok() {
        let dir = TempDir::new();
        let path = dir.nested_file();

        remove_at(&path, "k").expect("文件不存在时应成功");

        std::fs::create_dir_all(path.parent().expect("有父目录")).expect("创建父目录");
        store_at(&path, "k", "1.0.0", "/home/alice", "/home/alice/.qingcode").expect("写入缓存");

        remove_at(&path, "missing").expect("键不存在时应成功");
        assert!(load_at(&path, "k", "1.0.0").is_some());

        remove_at(&path, "k").expect("删除已有键");
        assert_eq!(load_at(&path, "k", "1.0.0"), None);
    }

    #[test]
    fn identity_key_requires_fingerprint_and_normalizes_host() {
        assert_eq!(identity_key("alice", "Example.COM", 22, None), None);
        assert_eq!(identity_key("alice", "Example.COM", 22, Some("   ")), None);
        assert_eq!(identity_key("alice", "Example.COM", 22, Some("\t\n")), None);
        assert_eq!(
            identity_key("alice", "Example.COM", 2222, Some(" SHA256:abc ")),
            Some("alice@example.com:2222#SHA256:abc".to_string())
        );
    }
}
