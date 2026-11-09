//! SSH 凭据（密码 / 私钥口令）的本机加密存储。
//!
//! - Windows：使用 DPAPI（`CryptProtectData`），密文只能由当前 Windows 用户解开。
//! - 其他平台：AES-256-GCM，密钥保存在应用数据目录下权限为 0600 的独立文件中。
//!
//! 密文按连接 id 存放在 `ssh-secrets.json`；明文凭据不会写入数据库或日志。
//! 只有用户在界面上明确勾选“记住”时才会写入。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

impl SshSecrets {
    fn is_empty(&self) -> bool {
        self.password.as_deref().unwrap_or("").is_empty()
            && self.passphrase.as_deref().unwrap_or("").is_empty()
    }
}

#[cfg(windows)]
fn protect(dir: &Path, plain: &[u8]) -> Result<Vec<u8>, String> {
    let _ = dir;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    const ENTROPY: &[u8] = b"qingcode-ssh-secret-v1";
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: 输入/熵结构指向存活的切片；输出由系统分配，复制后用 LocalFree 释放。
    unsafe {
        if CryptProtectData(
            &input,
            std::ptr::null(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            1, // CRYPTPROTECT_UI_FORBIDDEN
            &mut output,
        ) == 0
        {
            return Err("系统加密凭据失败".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect(dir: &Path, cipher: &[u8]) -> Result<Vec<u8>, String> {
    let _ = dir;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    const ENTROPY: &[u8] = b"qingcode-ssh-secret-v1";
    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: 同 protect。
    unsafe {
        if CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            1,
            &mut output,
        ) == 0
        {
            return Err("无法解密已保存的凭据（可能来自其他 Windows 用户）".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn load_key(dir: &Path) -> Result<[u8; 32], String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let path = dir.join("ssh-secrets.key");
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "生成加密密钥失败".to_string())?;
    fs::write(&path, key).map_err(|error| format!("写入加密密钥失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

#[cfg(not(windows))]
fn protect(dir: &Path, plain: &[u8]) -> Result<Vec<u8>, String> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use ring::rand::{SecureRandom, SystemRandom};
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, &load_key(dir)?).map_err(|_| "加密密钥无效".to_string())?,
    );
    let mut nonce = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "生成随机数失败".to_string())?;
    let mut buffer = plain.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::empty(),
        &mut buffer,
    )
    .map_err(|_| "加密凭据失败".to_string())?;
    let mut out = nonce.to_vec();
    out.extend(buffer);
    Ok(out)
}

#[cfg(not(windows))]
fn unprotect(dir: &Path, cipher: &[u8]) -> Result<Vec<u8>, String> {
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    if cipher.len() < 12 + 16 {
        return Err("已保存的凭据已损坏".into());
    }
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, &load_key(dir)?).map_err(|_| "加密密钥无效".to_string())?,
    );
    let (nonce, body) = cipher.split_at(12);
    let mut buffer = body.to_vec();
    let plain = key
        .open_in_place(
            Nonce::try_assume_unique_for_key(nonce)
                .map_err(|_| "已保存的凭据已损坏".to_string())?,
            Aad::empty(),
            &mut buffer,
        )
        .map_err(|_| "无法解密已保存的凭据".to_string())?;
    Ok(plain.to_vec())
}

fn store_path(dir: &Path) -> PathBuf {
    dir.join("ssh-secrets.json")
}

fn read_store(dir: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(store_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_store(dir: &Path, store: &BTreeMap<String, String>) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
    let path = store_path(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(store).map_err(|error| error.to_string())?;
    fs::write(&tmp, text).map_err(|error| format!("保存凭据失败：{error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("保存凭据失败：{error}"))
}

pub(crate) fn save_in(dir: &Path, id: &str, secrets: &SshSecrets) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read_store(dir);
    if secrets.is_empty() {
        store.remove(id);
    } else {
        fs::create_dir_all(dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
        let plain = serde_json::to_vec(secrets).map_err(|error| error.to_string())?;
        store.insert(id.to_string(), B64.encode(protect(dir, &plain)?));
    }
    write_store(dir, &store)
}

pub(crate) fn load_in(dir: &Path, id: &str) -> Result<Option<SshSecrets>, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(blob) = read_store(dir).get(id).cloned() else {
        return Ok(None);
    };
    let cipher = B64
        .decode(blob)
        .map_err(|_| "已保存的凭据已损坏".to_string())?;
    let plain = unprotect(dir, &cipher)?;
    serde_json::from_slice(&plain)
        .map(Some)
        .map_err(|_| "已保存的凭据已损坏".to_string())
}

pub(crate) fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = read_store(dir);
    if store.remove(id).is_some() {
        write_store(dir, &store)?;
    }
    Ok(())
}

/// 保存（覆盖）某连接的凭据；两项都为空等同于删除。
#[tauri::command]
pub fn ssh_secret_save(id: String, secrets: SshSecrets) -> Result<(), String> {
    save_in(&crate::app_paths::app_data_dir(), &id, &secrets)
}

/// 读取已保存的凭据；没有或无法解密时返回 `None`（解密失败视为未保存）。
#[tauri::command]
pub fn ssh_secret_load(id: String) -> Option<SshSecrets> {
    load_in(&crate::app_paths::app_data_dir(), &id)
        .ok()
        .flatten()
}

#[tauri::command]
pub fn ssh_secret_delete(id: String) -> Result<(), String> {
    delete_in(&crate::app_paths::app_data_dir(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qingcode-ssh-secrets-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn secrets_round_trip_without_plaintext_on_disk() {
        let dir = temp_dir("roundtrip");
        let secrets = SshSecrets {
            password: Some("p@ss-明文".into()),
            passphrase: None,
        };
        save_in(&dir, "conn-1", &secrets).unwrap();
        let on_disk = fs::read_to_string(store_path(&dir)).unwrap();
        assert!(!on_disk.contains("p@ss"));
        assert_eq!(load_in(&dir, "conn-1").unwrap(), Some(secrets));
        assert_eq!(load_in(&dir, "other").unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_secrets_and_delete_remove_entry() {
        let dir = temp_dir("delete");
        let secrets = SshSecrets {
            password: Some("x".into()),
            passphrase: Some("y".into()),
        };
        save_in(&dir, "a", &secrets).unwrap();
        save_in(&dir, "b", &secrets).unwrap();
        save_in(&dir, "a", &SshSecrets::default()).unwrap();
        assert_eq!(load_in(&dir, "a").unwrap(), None);
        delete_in(&dir, "b").unwrap();
        assert_eq!(load_in(&dir, "b").unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupted_blob_is_reported_not_panicking() {
        let dir = temp_dir("corrupt");
        let mut store = BTreeMap::new();
        store.insert(
            "a".to_string(),
            B64.encode(b"garbage-bytes-not-valid-cipher-0123456789"),
        );
        write_store(&dir, &store).unwrap();
        assert!(load_in(&dir, "a").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
