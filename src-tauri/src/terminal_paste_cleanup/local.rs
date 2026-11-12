use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub(crate) const MAX_CLEANUP_ENTRIES: usize = 20_000;

pub(crate) fn cleanup_cutoff(days: u32) -> Result<SystemTime, String> {
    if ![0, 7, 15, 30].contains(&days) {
        return Err("粘贴附件保留天数无效".into());
    }
    SystemTime::now()
        .checked_sub(Duration::from_secs(u64::from(days) * 86400))
        .ok_or_else(|| "粘贴附件保留天数无效".into())
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true; // Includes junctions, not only symbolic links.
        }
    }
    metadata.file_type().is_symlink()
}

fn safe_path(root: &Path, target: &Path) -> bool {
    let Ok(relative) = target.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            return false;
        };
        if is_link(&metadata) {
            return false;
        }
    }
    fs::canonicalize(target).is_ok_and(|resolved| resolved.starts_with(root))
}

// Postorder snapshot; any unreadable/new/special/link entry preserves the batch.
fn expired_tree(
    root: &Path,
    batch: &Path,
    cutoff: SystemTime,
    remaining: &mut usize,
    started: Instant,
) -> Option<Vec<(PathBuf, bool)>> {
    let mut pending = vec![batch.to_path_buf()];
    let mut entries = Vec::new();
    while let Some(path) = pending.pop() {
        *remaining = remaining.checked_sub(1)?;
        if started.elapsed() > Duration::from_secs(10) || !safe_path(root, &path) {
            return None;
        }
        let metadata = fs::symlink_metadata(&path).ok()?;
        if (!metadata.is_dir() && !metadata.is_file()) || metadata.modified().ok()? >= cutoff {
            return None;
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).ok()? {
                pending.push(entry.ok()?.path());
                if pending.len() > *remaining {
                    return None;
                }
            }
        }
        entries.push((path, metadata.is_dir()));
    }
    entries.reverse();
    Some(entries)
}

pub(super) fn cleanup_local(
    path: &str,
    cutoff: SystemTime,
    excluded: &[String],
    guard: impl Fn(&Path) -> Result<(), String>,
) -> Result<usize, String> {
    let root = fs::canonicalize(path).map_err(|error| error.to_string())?;
    guard(&root)?;
    let paste = root.join(".qingcode/terminal-paste");
    if !safe_path(&root, &paste) {
        return Ok(0);
    }
    let excluded: Vec<PathBuf> = excluded
        .iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect();
    let mut remaining = MAX_CLEANUP_ENTRIES;
    let started = Instant::now();
    let mut removed = 0;
    for entry in fs::read_dir(&paste).map_err(|error| error.to_string())? {
        if remaining == 0 || started.elapsed() > Duration::from_secs(10) {
            break;
        }
        remaining -= 1;
        let batch = entry.map_err(|error| error.to_string())?.path();
        if excluded
            .iter()
            .any(|path| path.starts_with(&batch) || batch.starts_with(path))
        {
            continue;
        }
        let Some(entries) = expired_tree(&root, &batch, cutoff, &mut remaining, started) else {
            continue;
        };
        for (target, is_dir) in entries {
            if started.elapsed() > Duration::from_secs(10) {
                return Ok(removed);
            }
            guard(&target)?;
            if !safe_path(&root, &target) {
                break;
            }
            if is_dir {
                // Fails safely if an upload added a file after the snapshot.
                if fs::remove_dir(&target).is_ok() && target == batch {
                    removed += 1;
                }
            } else if fs::symlink_metadata(&target)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .is_some_and(|modified| modified < cutoff)
                && fs::remove_file(&target).is_ok()
                && target == batch
            {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
