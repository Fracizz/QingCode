//! 远端 CLI（Claude Code / Codex）自身的目录信任记录，供 CLI 预热自动挑选启动目录。
//!
//! 只在用户为该连接显式开启后由前端调用：只读、固定文件（`~/.claude.json`、
//! `~/.codex/config.toml`），文件内容不离开本模块，只返回「QingCode 已注册且已信任、
//! 同时被该 CLI 信任」的项目根 URI。OpenCode 没有目录信任，不需要读取。

use super::*;

/// `.claude.json` 可能带大量历史，超过上限视为读取失败而不是截断解析。
const MAX_CLI_CONFIG_BYTES: u64 = 32 * 1024 * 1024;
/// 远端脚本：文件不存在。
const EXIT_NOT_FOUND: u32 = 3;
/// 远端脚本：文件超过上限。
const EXIT_TOO_LARGE: u32 = 4;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliTrustedRoots {
    /// 该 CLI 的配置文件是否存在。
    pub config_found: bool,
    /// 被该 CLI 信任的已注册、已信任项目根 URI。
    pub roots: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CliAgent {
    Claude,
    Codex,
}

impl CliAgent {
    fn parse(agent: &str) -> Result<Self, String> {
        match agent {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err("仅支持读取 Claude Code 或 Codex 的信任配置".into()),
        }
    }

    /// (POSIX sh, Windows PowerShell)。路径固定，只认 CLI 自己的配置目录环境变量。
    fn read_commands(self) -> (String, String) {
        let (unix_path, windows_dir, file) = match self {
            Self::Claude => (
                r#""${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json""#,
                "if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { $env:USERPROFILE }",
                ".claude.json",
            ),
            Self::Codex => (
                r#""${CODEX_HOME:-$HOME/.codex}/config.toml""#,
                "if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }",
                "config.toml",
            ),
        };
        let unix = format!(
            "f={unix_path}; [ -f \"$f\" ] || exit {EXIT_NOT_FOUND}; \
             s=$(wc -c < \"$f\") || exit 1; [ $s -le {MAX_CLI_CONFIG_BYTES} ] || exit {EXIT_TOO_LARGE}; cat -- \"$f\""
        );
        let windows = format!(
            "$f = Join-Path ({windows_dir}) '{file}'\n\
             if (!(Test-Path -LiteralPath $f -PathType Leaf)) {{ exit {EXIT_NOT_FOUND} }}\n\
             if ((Get-Item -LiteralPath $f).Length -gt {MAX_CLI_CONFIG_BYTES}) {{ exit {EXIT_TOO_LARGE} }}\n\
             [Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
             [Console]::Out.Write([IO.File]::ReadAllText($f))"
        );
        (unix, windows)
    }

    fn trusted_dirs(self, content: &str) -> Result<Vec<String>, String> {
        match self {
            Self::Claude => claude_trusted_dirs(content),
            Self::Codex => Ok(codex_trusted_dirs(content)),
        }
    }

    /// Claude 的信任会被子目录继承；Codex 按仓库根或当前目录精确查，不能按上级目录推断。
    fn inherits(self) -> bool {
        matches!(self, Self::Claude)
    }
}

fn claude_trusted_dirs(content: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| "Claude 配置不是有效的 JSON".to_string())?;
    Ok(value
        .get("projects")
        .and_then(|p| p.as_object())
        .map(|projects| {
            projects
                .iter()
                .filter(|(_, v)| v.get("hasTrustDialogAccepted") == Some(&true.into()))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default())
}

/// 只认 `[projects."<path>"]` / `[projects.'<path>']` 表里的 `trust_level = "trusted"`，
/// 这是 Codex 自己写入的格式；不完整实现 TOML。
fn codex_trusted_dirs(content: &str) -> Vec<String> {
    let mut dirs = Vec::new();
    let mut current: Option<String> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current = codex_project_header(line);
            continue;
        }
        let Some(dir) = &current else { continue };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.split('#').next().unwrap_or_default().trim();
        if key.trim() == "trust_level" && matches!(value, "\"trusted\"" | "'trusted'") {
            dirs.push(dir.clone());
        }
    }
    dirs
}

fn codex_project_header(line: &str) -> Option<String> {
    let inner = line.strip_prefix("[projects.")?.trim_end();
    let inner = inner.strip_suffix(']')?;
    if let Some(literal) = inner.strip_prefix('\'') {
        return literal.strip_suffix('\'').map(str::to_owned);
    }
    let basic = inner.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::new();
    let mut chars = basic.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next()? {
            '\\' => out.push('\\'),
            '"' => out.push('"'),
            // 路径里不会出现其他转义；遇到就放弃该项而不是猜。
            _ => return None,
        }
    }
    Some(out)
}

/// 统一为 `/` 分隔、无结尾分隔符；Windows 盘符路径不区分大小写。
fn normalize_dir(path: &str) -> String {
    let (path, windows) = match windows_native_path(path) {
        Some(native) => (native, true),
        None => (path.to_owned(), false),
    };
    let mut path = path.replace('\\', "/");
    while path.len() > 1 && path.ends_with('/') && !path.ends_with(":/") {
        path.pop();
    }
    if windows {
        path.to_ascii_lowercase()
    } else {
        path
    }
}

fn dir_covers(trusted: &str, root: &str, inherits: bool) -> bool {
    if trusted == root {
        return true;
    }
    if !inherits {
        return false;
    }
    let prefix = if trusted.ends_with('/') {
        trusted.to_owned()
    } else {
        format!("{trusted}/")
    };
    root.starts_with(&prefix)
}

fn match_roots(agent: CliAgent, trusted: &[String], roots: &[RegisteredRoot]) -> Vec<String> {
    let trusted: Vec<_> = trusted.iter().map(|d| normalize_dir(d)).collect();
    roots
        .iter()
        .filter(|root| {
            let root_dir = normalize_dir(&root.canonical_path);
            trusted
                .iter()
                .any(|dir| dir_covers(dir, &root_dir, agent.inherits()))
        })
        .map(|root| root.uri.clone())
        .collect()
}

#[tauri::command]
pub async fn ssh_cli_trusted_roots(
    connection_id: String,
    agent: String,
    manager: State<'_, SshManager>,
) -> Result<CliTrustedRoots, String> {
    let agent = CliAgent::parse(&agent)?;
    let mut roots: Vec<_> = manager
        .roots_for_connection(&connection_id)
        .into_iter()
        .filter(|root| root.trusted)
        .collect();
    roots.sort_by(|a, b| a.uri.cmp(&b.uri));
    // 远端命令必须挂在一个已信任项目上执行；没有就无从读取也无可匹配。
    let Some(first) = roots.first() else {
        return Ok(CliTrustedRoots {
            config_found: false,
            roots: Vec::new(),
        });
    };
    let (unix, windows) = agent.read_commands();
    let output = manager
        .exec_remote_shell(&first.uri, &unix, &windows, true, Duration::from_secs(20))
        .await?;
    match output.exit_code {
        0 => {}
        EXIT_NOT_FOUND => {
            return Ok(CliTrustedRoots {
                config_found: false,
                roots: Vec::new(),
            })
        }
        EXIT_TOO_LARGE => return Err("CLI 配置文件过大，无法读取".into()),
        code => return Err(format!("读取 CLI 配置失败（退出码 {code}）")),
    }
    let trusted = agent.trusted_dirs(&output.stdout)?;
    Ok(CliTrustedRoots {
        config_found: true,
        roots: match_roots(agent, &trusted, &roots),
    })
}

#[cfg(test)]
mod tests;
