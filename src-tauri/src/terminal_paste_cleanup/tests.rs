use super::*;

fn workspace() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "qingcode-paste-cleanup-{}",
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join(".qingcode/terminal-paste")).unwrap();
    root
}

fn age(path: &Path, days: u64) {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(!path.is_dir());
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x02000000).access_mode(0x0100); // FILE_FLAG_BACKUP_SEMANTICS for directory timestamps.
    }
    options
        .open(path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::now() - Duration::from_secs(days * 86400)),
        )
        .unwrap();
}

fn batch(root: &Path, name: &str, days: u64) -> PathBuf {
    let dir = root.join(".qingcode/terminal-paste").join(name);
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("image.png"), b"attachment").unwrap();
    age(&dir.join("image.png"), days);
    age(&dir, days);
    dir
}

#[test]
fn removes_only_expired_batches_and_preserves_recent_files() {
    let root = workspace();
    let old = batch(&root, "old", 10);
    let fresh = batch(&root, "fresh", 0);
    let changed = batch(&root, "changed", 10);
    age(&changed.join("image.png"), 0);
    let new_upload = batch(&root, "new-upload-with-old-file", 10);
    age(&new_upload, 0);
    fs::write(root.join(".qingcode/run.json"), b"keep").unwrap();
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(7).unwrap(),
            &[],
            |_| Ok(())
        )
        .unwrap(),
        1
    );
    assert!(!old.exists());
    assert!(fresh.exists() && changed.exists() && new_upload.exists());
    assert!(root.join(".qingcode/run.json").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_cleanup_skips_active_upload_and_missing_directory() {
    let root = workspace();
    let active = batch(&root, "active", 10);
    let old = batch(&root, "old", 10);
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(0).unwrap(),
            &[active.to_string_lossy().into()],
            |_| Ok(())
        )
        .unwrap(),
        1
    );
    assert!(active.exists() && !old.exists());
    fs::remove_dir_all(root.join(".qingcode/terminal-paste")).unwrap();
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(7).unwrap(),
            &[],
            |_| Ok(())
        )
        .unwrap(),
        0
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn denied_trust_preserves_files() {
    let root = workspace();
    let old = batch(&root, "old", 10);
    assert!(cleanup_local(
        root.to_str().unwrap(),
        cleanup_cutoff(7).unwrap(),
        &[],
        |_| Err("untrusted".into())
    )
    .is_err());
    assert!(old.exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_managed_directory_and_nested_symlinks() {
    use std::os::unix::fs::symlink;
    let root = workspace();
    let outside = workspace();
    let sentinel = batch(&outside, "sentinel", 10);
    let linked_batch = batch(&root, "linked-batch", 10);
    symlink(&sentinel, linked_batch.join("escape")).unwrap();
    age(&linked_batch, 10);
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(7).unwrap(),
            &[],
            |_| Ok(())
        )
        .unwrap(),
        0
    );
    assert!(sentinel.join("image.png").exists() && linked_batch.join("image.png").exists());
    fs::remove_dir_all(root.join(".qingcode")).unwrap();
    symlink(outside.join(".qingcode"), root.join(".qingcode")).unwrap();
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(0).unwrap(),
            &[],
            |_| Ok(())
        )
        .unwrap(),
        0
    );
    assert!(sentinel.exists());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn rejects_invalid_retention() {
    assert!(cleanup_cutoff(1).is_err());
    assert!(cleanup_cutoff(u32::MAX).is_err());
}

#[test]
fn concurrent_new_and_changed_files_survive_deletion() {
    let root = workspace();
    let dir = batch(&root, "concurrent", 10);
    let file = dir.join("image.png");
    let count = cleanup_local(
        root.to_str().unwrap(),
        cleanup_cutoff(7).unwrap(),
        &[],
        |target| {
            if target.file_name() == Some(std::ffi::OsStr::new("image.png")) {
                fs::write(&file, b"changed after snapshot").unwrap();
                fs::write(dir.join("new.png"), b"new upload").unwrap();
            }
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(count, 0);
    assert!(file.exists() && dir.join("new.png").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn entry_budget_preserves_an_incompletely_scanned_batch() {
    let root = workspace();
    let dir = batch(&root, "too-many", 10);
    let mut remaining = 1;
    assert!(expired_tree(
        &root,
        &dir,
        cleanup_cutoff(7).unwrap(),
        &mut remaining,
        Instant::now()
    )
    .is_none());
    assert!(dir.join("image.png").exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn rejects_windows_junctions_in_managed_paths() {
    let root = workspace();
    let outside = workspace();
    let sentinel = batch(&outside, "sentinel", 10);
    let dir = batch(&root, "linked-batch", 10);
    let junction = dir.join("escape");
    let result = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(junction.to_string_lossy().replace('/', "\\"))
        .arg(sentinel.to_string_lossy().replace('/', "\\"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    age(&dir, 10);
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(7).unwrap(),
            &[],
            |_| Ok(())
        )
        .unwrap(),
        0
    );
    assert!(sentinel.join("image.png").exists() && dir.join("image.png").exists());
    fs::remove_dir(&junction).unwrap();
    fs::remove_dir_all(root.join(".qingcode/terminal-paste")).unwrap();
    let paste = root.join(".qingcode/terminal-paste");
    let result = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(paste.to_string_lossy().replace('/', "\\"))
        .arg(
            outside
                .join(".qingcode/terminal-paste")
                .to_string_lossy()
                .replace('/', "\\"),
        )
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        cleanup_local(
            root.to_str().unwrap(),
            cleanup_cutoff(0).unwrap(),
            &[],
            |_| Ok(())
        )
        .unwrap(),
        0
    );
    assert!(sentinel.join("image.png").exists());
    fs::remove_dir(paste).unwrap();
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}
