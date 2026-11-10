//! 手机连接的持久化：设置文件、会话名、配对码校验，以及指纹/时间等小工具。

use super::*;

#[derive(Serialize, Deserialize)]
pub(super) struct SavedSettings {
    #[serde(flatten)]
    pub(super) endpoint: SavedEndpoint,
    pub(super) certificate: Vec<u8>,
    pub(super) private_key: Vec<u8>,
    pub(super) code: CodeVerifier,
    /// Kept with the certificate key in the owner-only settings file so the desktop can
    /// restore and reveal it. Legacy verifier-only files still load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) password: Option<String>,
    /// Restart the listener automatically when the desktop starts.
    #[serde(default)]
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) devices: Vec<Device>,
    /// 允许手机接入电脑上开的终端；默认关闭，由用户在设置中显式开启。
    #[serde(default)]
    pub(super) desktop_terminals: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum SavedEndpoint {
    Port { port: u16 },
    Legacy { address: SocketAddrV4 },
}

impl SavedEndpoint {
    pub(super) fn port(&self) -> u16 {
        match self {
            Self::Port { port } => *port,
            Self::Legacy { address } => address.port(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct CodeVerifier {
    pub(super) salt: [u8; 16],
    pub(super) digest: [u8; 32],
}

pub(super) fn valid_code(code: &str) -> bool {
    (6..=20).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_graphic())
}

impl CodeVerifier {
    pub(super) fn new(code: &str) -> Result<Self, String> {
        if !valid_code(code) {
            return Err("密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。".into());
        }
        let salt = *Uuid::new_v4().as_bytes();
        let mut digest = [0; 32];
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            CODE_ROUNDS,
            &salt,
            code.as_bytes(),
            &mut digest,
        );
        Ok(Self { salt, digest })
    }

    pub(super) fn matches(&self, code: &str) -> bool {
        valid_code(code)
            && pbkdf2::verify(
                pbkdf2::PBKDF2_HMAC_SHA256,
                CODE_ROUNDS,
                &self.salt,
                code.as_bytes(),
                &self.digest,
            )
            .is_ok()
    }
}

pub(super) fn settings_path() -> PathBuf {
    crate::app_paths::app_data_dir()
        .join("mobile")
        .join("settings.json")
}

pub(super) fn load_settings() -> Result<Option<SavedSettings>, String> {
    let path = settings_path();
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let content = qingcode_server::direct::private_read(&path)?;
    serde_json::from_slice(&content)
        .map(Some)
        .map_err(|error| format!("读取移动连接设置失败：{error}"))
}

pub(super) fn save_settings(settings: &SavedSettings) -> Result<(), String> {
    let path = settings_path();
    qingcode_server::direct::protect_private_directory(path.parent().unwrap())?;
    let content = serde_json::to_vec(settings).map_err(|error| error.to_string())?;
    qingcode_server::direct::private_write(&path, &content)
}

pub(super) fn update_settings(change: impl FnOnce(&mut SavedSettings)) -> Result<(), String> {
    let _guard = SETTINGS_FILE.lock().unwrap();
    let Some(mut settings) = load_settings()? else {
        return Ok(());
    };
    change(&mut settings);
    save_settings(&settings)
}

pub(super) fn session_names_path() -> PathBuf {
    crate::app_paths::app_data_dir()
        .join("mobile")
        .join("session-names.json")
}

/// 名称文件只影响显示，读取失败按没有保存过处理，不影响接回终端。
pub(super) fn load_session_names() -> HashMap<String, SavedSessionName> {
    let path = session_names_path();
    if std::fs::symlink_metadata(&path).is_err() {
        return HashMap::new();
    }
    qingcode_server::direct::private_read(&path)
        .and_then(|content| serde_json::from_slice(&content).map_err(|error| error.to_string()))
        .unwrap_or_else(|error| {
            eprintln!("[WARN] 读取手机会话名称失败：{error}");
            HashMap::new()
        })
}

pub(super) fn save_session_names(names: &HashMap<String, SavedSessionName>) -> Result<(), String> {
    let path = session_names_path();
    qingcode_server::direct::protect_private_directory(path.parent().unwrap())?;
    let content = serde_json::to_vec(names).map_err(|error| error.to_string())?;
    qingcode_server::direct::private_write(&path, &content)
}

/// 定期把手机会话名称写入磁盘，电脑重启或升级后接回时恢复。只有这一个写入方。
pub(super) async fn persist_session_names(
    app: AppHandle,
    mut written: HashMap<String, SavedSessionName>,
) {
    loop {
        tokio::time::sleep(SESSION_NAMES_SAVE_INTERVAL).await;
        let names = app.state::<MobileState>().hub.session_names_snapshot();
        if names == written {
            continue;
        }
        let content = names.clone();
        let result = tauri::async_runtime::spawn_blocking(move || save_session_names(&content))
            .await
            .map_err(|error| error.to_string())
            .and_then(|saved| saved);
        if let Err(error) = result {
            eprintln!("[WARN] 保存手机会话名称失败：{error}");
        }
        // 失败也更新：下次内容变化时重试，避免磁盘问题时每两秒写一次日志。
        written = names;
    }
}

pub(super) fn fingerprint(certificate: &[u8]) -> String {
    format!("{:x}", Sha256::digest(certificate))
}

pub(super) fn token_digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub(super) fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as u64)
}

pub(super) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub(super) fn device_name(name: Option<&str>) -> String {
    let name: String = name
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DEVICE_NAME)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "Android 设备".into()
    } else {
        name.into()
    }
}
