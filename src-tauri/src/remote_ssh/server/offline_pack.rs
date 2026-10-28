//! Import an offline pack entirely on the client. Only verified server binaries
//! enter a private cache directory; deployment continues through the usual SFTP path.

use super::download::{parse_server_manifest, verify_server_sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const BINARY_NAMES: [&str; 4] = [
    "qingcode-server-x86_64",
    "qingcode-server-aarch64",
    "qingcode-server-windows-x86_64.exe",
    "qingcode-server-windows-aarch64.exe",
];

pub(crate) fn import_offline_server_pack(path: &Path, cache: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开离线 ZIP 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取离线 ZIP 失败：{e}"))?;
    if archive.len() > 64 {
        return Err("离线 ZIP 文件数量超出限制".into());
    }
    let mut files = HashMap::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        // ZIPs created on Windows may use backslashes. Never join archive paths
        // onto the local filesystem, and reject traversal even in ignored entries.
        let name = entry.name().map_err(|e| e.to_string())?.replace('\\', "/");
        if name.starts_with('/')
            || name.contains(':')
            || name.contains('\0')
            || name.split('/').any(|part| part == "..")
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("离线 ZIP 含有不安全的路径或符号链接".into());
        }
        if entry.is_dir() {
            continue;
        }
        let relative = name
            .strip_prefix("servers/")
            .or_else(|| name.strip_prefix("agents/"))
            .unwrap_or(&name);
        if (relative == "manifest.json" || BINARY_NAMES.contains(&relative))
            && files.insert(relative.to_string(), index).is_some()
        {
            return Err(format!("离线 ZIP 含有重复文件：{relative}"));
        }
    }
    let manifest_index = files
        .get("manifest.json")
        .ok_or("离线 ZIP 缺少 manifest.json，请使用 QingCode-servers.zip")?;
    let manifest = {
        let mut bytes = Vec::new();
        archive
            .by_index(*manifest_index)
            .map_err(|e| e.to_string())?
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取离线清单失败：{e}"))?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("离线清单体积超出限制".into());
        }
        parse_server_manifest(&bytes)?
    };
    if manifest.version != qingcode_server::SERVER_VERSION {
        return Err(format!(
            "离线服务版本不匹配：需要 {}，ZIP 为 {}",
            qingcode_server::SERVER_VERSION,
            manifest.version
        ));
    }
    if !BINARY_NAMES.iter().any(|name| files.contains_key(*name)) {
        return Err("离线 ZIP 没有可用的 qingcode-server 二进制".into());
    }

    std::fs::create_dir_all(cache).map_err(|e| format!("创建离线缓存失败：{e}"))?;
    let output = cache.join(format!("offline-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&output).map_err(|e| format!("创建离线缓存失败：{e}"))?;
    let result = (|| {
        use sha2::Digest;
        for name in BINARY_NAMES {
            let Some(index) = files.get(name) else {
                continue;
            };
            let artifact = manifest
                .artifacts
                .get(name)
                .ok_or_else(|| format!("离线清单缺少 {name} 条目"))?;
            let mut entry = archive.by_index(*index).map_err(|e| e.to_string())?;
            if artifact.size == 0
                || artifact.size > MAX_BINARY_BYTES
                || entry.size() != artifact.size
            {
                return Err(format!("离线二进制体积不符合清单或超出限制：{name}"));
            }
            let mut target = std::fs::File::create(output.join(name))
                .map_err(|e| format!("创建离线二进制失败：{e}"))?;
            let mut hasher = sha2::Sha256::new();
            let mut written = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = entry
                    .read(&mut buffer)
                    .map_err(|e| format!("解压失败：{e}"))?;
                if count == 0 {
                    break;
                }
                written += count as u64;
                if written > artifact.size {
                    return Err(format!("离线二进制体积超出清单限制：{name}"));
                }
                hasher.update(&buffer[..count]);
                target
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
            }
            if written != artifact.size {
                return Err(format!("离线二进制不完整：{name}"));
            }
            verify_server_sha256(&artifact.sha256, &hasher.finalize().into())?;
            target.sync_all().map_err(|e| e.to_string())?;
        }
        Ok(output.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&output);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use zip::write::SimpleFileOptions;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("qingcode-pack-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn pack(
            &self,
            prefix: &str,
            version: &str,
            bytes: &[u8],
            extras: &[(&str, bool)],
        ) -> PathBuf {
            let path = self.0.join("QingCode-servers.zip");
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let digest = format!("{:x}", sha2::Sha256::digest(b"server"));
            let manifest = serde_json::json!({
                "version": version,
                "artifacts": {"qingcode-server-x86_64": {"size": 6, "sha256": digest}}
            });
            zip.start_file(
                format!("{prefix}manifest.json"),
                SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(manifest.to_string().as_bytes()).unwrap();
            zip.start_file(
                format!("{prefix}qingcode-server-x86_64"),
                SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(bytes).unwrap();
            for (name, symlink) in extras {
                if *symlink {
                    zip.add_symlink(*name, "outside", SimpleFileOptions::default())
                        .unwrap();
                } else {
                    zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                    zip.write_all(b"extra").unwrap();
                }
            }
            zip.finish().unwrap();
            path
        }

        fn cache(&self) -> PathBuf {
            self.0.join("cache")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imports_root_or_nested_layout_and_keeps_imports_isolated() {
        let fixture = Fixture::new();
        let mut previous = None;
        for prefix in ["", "servers/", "agents/", "servers\\"] {
            let path = fixture.pack(prefix, qingcode_server::SERVER_VERSION, b"server", &[]);
            let dir = import_offline_server_pack(&path, &fixture.cache()).unwrap();
            assert_eq!(std::fs::read(dir.join(BINARY_NAMES[0])).unwrap(), b"server");
            assert_ne!(previous, Some(dir.clone()));
            previous = Some(dir);
        }
    }

    #[test]
    fn rejects_corrupt_hash_size_and_wrong_version_without_cache_residue() {
        let fixture = Fixture::new();
        for (version, bytes, reason) in [
            (qingcode_server::SERVER_VERSION, &b"broken"[..], "sha256"),
            (qingcode_server::SERVER_VERSION, &b"short"[..], "体积"),
            ("0.0.0", &b"server"[..], "版本不匹配"),
        ] {
            let path = fixture.pack("", version, bytes, &[]);
            let error = import_offline_server_pack(&path, &fixture.cache()).unwrap_err();
            assert!(error.contains(reason), "{error}");
            if fixture.cache().exists() {
                assert_eq!(std::fs::read_dir(fixture.cache()).unwrap().count(), 0);
            }
        }
    }

    #[test]
    fn rejects_traversal_absolute_paths_symlinks_and_duplicate_binaries() {
        let fixture = Fixture::new();
        for (name, symlink, reason) in [
            ("../escape", false, "不安全"),
            ("servers\\..\\escape", false, "不安全"),
            ("/absolute", false, "不安全"),
            ("D:/absolute", false, "不安全"),
            ("link", true, "不安全"),
            ("servers/qingcode-server-x86_64", false, "重复"),
        ] {
            let path = fixture.pack(
                "",
                qingcode_server::SERVER_VERSION,
                b"server",
                &[(name, symlink)],
            );
            let error = import_offline_server_pack(&path, &fixture.cache()).unwrap_err();
            assert!(error.contains(reason), "{name}: {error}");
            assert!(!fixture.cache().exists());
        }
    }

    #[test]
    fn rejects_missing_or_oversized_manifest() {
        let fixture = Fixture::new();
        let path = fixture.0.join("invalid.zip");
        for size in [0, MAX_MANIFEST_BYTES + 1] {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            if size > 0 {
                zip.start_file("manifest.json", SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(&vec![b' '; size as usize]).unwrap();
            }
            zip.finish().unwrap();
            assert!(import_offline_server_pack(&path, &fixture.cache()).is_err());
            assert!(!fixture.cache().exists());
        }
    }

    #[test]
    fn imports_real_pack_when_provided() {
        let Some(path) = std::env::var_os("QINGCODE_TEST_OFFLINE_PACK") else {
            return;
        };
        let fixture = Fixture::new();
        let dir = import_offline_server_pack(Path::new(&path), &fixture.cache()).unwrap();
        assert!(dir.join(BINARY_NAMES[0]).is_file());
    }
}
