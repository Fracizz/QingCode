//! Read OpenSSH configuration as data only. Never execute Match/Proxy commands.
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportCandidate {
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_kind: String,
    private_key_path: Option<String>,
    issue: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportCandidates {
    path: String,
    candidates: Vec<SshImportCandidate>,
}

#[derive(Debug)]
struct Directive {
    key: String,
    values: Vec<String>,
    included: Vec<Directive>,
}

// Backslashes in Windows paths stay literal unless escaping a quote/space/backslash.
fn words(line: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '#' if quote.is_none() => break,
            '\\' if chars
                .peek()
                .is_some_and(|c| matches!(c, '"' | '\'' | ' ' | '\\' | '#')) =>
            {
                word.push(chars.next().unwrap());
            }
            '"' | '\'' if quote == Some(ch) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(ch),
            c if quote.is_none()
                && (c.is_whitespace()
                    || (c == '='
                        && (result.is_empty() || result.len() == 1 && word.is_empty()))) =>
            {
                if !word.is_empty() {
                    result.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if quote.is_some() {
        return Err("SSH 配置含未闭合的引号".into());
    }
    if !word.is_empty() {
        result.push(word);
    }
    Ok(result)
}

fn home_path(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        PathBuf::from(value)
    }
}

fn read_directives(
    path: &Path,
    home: &Path,
    depth: usize,
    bytes: &mut usize,
    directives: &mut Vec<Directive>,
) -> Result<(), String> {
    if depth > 16 || directives.len() > 20_000 {
        return Err("SSH Include 层级过深或配置过大".into());
    }
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if depth == 0 && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let mut content = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut content)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    *bytes += content.len();
    if *bytes > 1024 * 1024 {
        return Err("SSH 配置超过 1 MB".into());
    }
    for line in content.trim_start_matches('\u{feff}').lines() {
        let mut values = words(line)?;
        if values.is_empty() {
            continue;
        }
        let key = values.remove(0).to_ascii_lowercase();
        if key == "include" {
            let mut included = Vec::new();
            for pattern in values {
                let expanded = home_path(&pattern, home);
                // OpenSSH user Include paths are relative to ~/.ssh, including nested files.
                let expanded = if expanded.is_absolute() {
                    expanded
                } else {
                    home.join(".ssh").join(expanded)
                };
                let pattern = expanded.to_string_lossy().replace('\\', "/");
                let files = glob::glob(&pattern).map_err(|error| error.to_string())?;
                for file in files {
                    read_directives(
                        &file.map_err(|error| error.to_string())?,
                        home,
                        depth + 1,
                        bytes,
                        &mut included,
                    )?;
                }
            }
            directives.push(Directive {
                key,
                values: Vec::new(),
                included,
            });
        } else {
            directives.push(Directive {
                key,
                values,
                included: Vec::new(),
            });
        }
    }
    Ok(())
}

fn matches_host(patterns: &[String], host: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        let negative = pattern.starts_with('!');
        let pattern = pattern.strip_prefix('!').unwrap_or(pattern);
        let matches = glob::Pattern::new(pattern).is_ok_and(|p| p.matches(host));
        if matches && negative {
            return false;
        }
        matched |= matches;
    }
    matched
}

fn collect_aliases(directives: &[Directive], aliases: &mut Vec<String>) {
    for directive in directives {
        collect_aliases(&directive.included, aliases);
        if directive.key != "host" {
            continue;
        }
        for name in &directive.values {
            if !name.contains(['*', '?', '[', '!', '%', '$']) && !aliases.contains(name) {
                aliases.push(name.clone());
            }
        }
    }
}

fn resolve_options<'a>(
    directives: &'a [Directive],
    name: &str,
    active: &mut bool,
    options: &mut HashMap<&'a str, &'a str>,
    issue: &mut Option<String>,
    found_alias: &mut bool,
) {
    for directive in directives {
        if directive.key == "match" {
            *issue = Some("配置包含 Match 条件，请手动新建连接".into());
            *active = false;
        } else if directive.key == "host" {
            *active = matches_host(&directive.values, name);
            *found_alias |= directive.values.iter().any(|value| value == name);
        } else if *active && directive.key == "include" {
            resolve_options(
                &directive.included,
                name,
                active,
                options,
                issue,
                found_alias,
            );
        } else if *active {
            if let Some(value) = directive.values.first() {
                if directive.key == "identityfile" && options.contains_key("identityfile") {
                    *issue = Some("配置包含多个私钥，请手动新建连接并选择私钥".into());
                }
                options
                    .entry(directive.key.as_str())
                    .or_insert(value.as_str());
            }
        }
    }
}

fn candidates(directives: &[Directive], home: &Path, local_user: &str) -> Vec<SshImportCandidate> {
    let mut aliases = Vec::new();
    collect_aliases(directives, &mut aliases);
    aliases
        .into_iter()
        .map(|name| {
            let mut active = true;
            let mut options = HashMap::new();
            let mut issue = None;
            let mut found_alias = false;
            resolve_options(
                directives,
                &name,
                &mut active,
                &mut options,
                &mut issue,
                &mut found_alias,
            );
            if !found_alias {
                issue = Some("配置位于未匹配的 Include 条件中，请手动新建连接".into());
            }
            let host = options
                .get("hostname")
                .unwrap_or(&name.as_str())
                .replace("%h", &name);
            let username = options
                .get("user")
                .copied()
                .unwrap_or(local_user)
                .to_string();
            let raw_port = options.get("port").copied().unwrap_or("22");
            let port = raw_port.parse::<u16>().ok().filter(|port| *port > 0);
            if port.is_none()
                || host.is_empty()
                || username.is_empty()
                || host.contains(['%', '$'])
                || username.contains(['%', '$'])
            {
                issue = Some("主机、用户名或端口无效，请手动新建连接".into());
            }
            for key in [
                "proxyjump",
                "proxycommand",
                "certificatefile",
                "identityagent",
            ] {
                if options
                    .get(key)
                    .is_some_and(|value| !value.eq_ignore_ascii_case("none"))
                {
                    issue = Some("暂不支持代理、证书或自定义认证代理，请手动新建连接".into());
                }
            }
            let private_key_path = options
                .get("identityfile")
                .filter(|value| !value.eq_ignore_ascii_case("none"))
                .map(|value| {
                    let expanded = value
                        .replace("%%", "\0")
                        .replace("%d", &home.to_string_lossy())
                        .replace("%u", local_user)
                        .replace("%h", &host)
                        .replace("%r", &username)
                        .replace("%p", raw_port);
                    if expanded.contains(['%', '$'])
                        || expanded.starts_with('~')
                            && !expanded.starts_with("~/")
                            && !expanded.starts_with("~\\")
                    {
                        issue = Some("私钥路径包含不支持的变量，请手动新建连接".into());
                    }
                    home_path(&expanded.replace('\0', "%"), home)
                        .to_string_lossy()
                        .to_string()
                });
            let password = options
                .get("preferredauthentications")
                .is_some_and(|value| !value.split(',').any(|method| method == "publickey"))
                || options
                    .get("pubkeyauthentication")
                    .is_some_and(|value| value.eq_ignore_ascii_case("no"));
            SshImportCandidate {
                name,
                host,
                port: port.unwrap_or(22),
                username,
                auth_kind: if password { "password" } else { "privateKey" }.into(),
                private_key_path,
                issue,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn ssh_import_candidates() -> Result<SshImportCandidates, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = dirs::home_dir().ok_or("无法定位用户目录以读取 SSH 配置")?;
        let path = home.join(".ssh").join("config");
        let user =
            std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default();
        let mut directives = Vec::new();
        read_directives(&path, &home, 0, &mut 0, &mut directives)?;
        Ok(SshImportCandidates {
            path: path.to_string_lossy().to_string(),
            candidates: candidates(&directives, &home, &user),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Vec<SshImportCandidate> {
        let directives = text
            .lines()
            .map(|line| {
                let mut values = words(line).unwrap();
                let key = values.remove(0).to_lowercase();
                Directive {
                    key,
                    values,
                    included: Vec::new(),
                }
            })
            .collect::<Vec<_>>();
        candidates(&directives, Path::new("/home/local"), "local")
    }

    #[test]
    fn aliases_defaults_first_value_and_negation() {
        let result = parse("Host dev alias\n HostName=server.test # comment\n User remote\n IdentityFile \"~/.ssh/key with space\"\nHost * !alias\n Port 2222\nHost *\n User ignored\n Port 22");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].host, "server.test");
        assert_eq!(result[0].username, "remote");
        assert_eq!(result[0].port, 2222);
        assert_eq!(result[1].port, 22);
        assert_eq!(
            result[0].private_key_path.as_deref(),
            Some("/home/local/.ssh/key with space")
        );
        assert!(result[0].issue.is_none());
    }

    #[test]
    fn defaults_tokens_password_and_windows_paths() {
        let result = parse("Host one\n IdentityFile %d/.ssh/%r@%h-%p\nHost two\n PreferredAuthentications password\n IdentityFile C:\\Users\\me\\key\nHost three\n Port 0");
        assert_eq!(result[0].host, "one");
        assert_eq!(result[0].username, "local");
        assert_eq!(
            result[0].private_key_path.as_deref(),
            Some("/home/local/.ssh/local@one-22")
        );
        assert_eq!(result[1].auth_kind, "password");
        assert_eq!(
            result[1].private_key_path.as_deref(),
            Some("C:\\Users\\me\\key")
        );
        assert!(result[2].issue.is_some());
    }

    #[test]
    fn unsupported_proxy_and_match_are_never_executed() {
        let result = parse(
            "Host dev\n ProxyCommand touch /tmp/do-not-create\nHost direct\n ProxyCommand none",
        );
        assert!(result[0].issue.is_some());
        assert!(result[1].issue.is_none());
        let result = parse("Host dev\nMatch exec \"exit 1\"\n User conditional");
        assert!(result[0].issue.is_some());
        assert!(words("Host \"unfinished").is_err());
    }

    #[test]
    fn includes_follow_user_ssh_root_and_cycles_are_bounded() {
        let home =
            std::env::temp_dir().join(format!("qingcode-ssh-import-{}", uuid::Uuid::new_v4()));
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(ssh.join("hosts")).unwrap();
        std::fs::write(
            ssh.join("config"),
            "Include hosts/*\nHost *\n User fallback",
        )
        .unwrap();
        std::fs::write(ssh.join("hosts/dev"), "Host dev\n HostName example.test").unwrap();
        let mut directives = Vec::new();
        read_directives(&ssh.join("config"), &home, 0, &mut 0, &mut directives).unwrap();
        assert_eq!(
            candidates(&directives, &home, "local")[0].username,
            "fallback"
        );
        std::fs::write(ssh.join("config"), "Host parent\n Include hosts/*").unwrap();
        directives.clear();
        read_directives(&ssh.join("config"), &home, 0, &mut 0, &mut directives).unwrap();
        let conditional = candidates(&directives, &home, "local");
        assert!(conditional
            .iter()
            .find(|item| item.name == "dev")
            .unwrap()
            .issue
            .is_some());
        std::fs::write(ssh.join("config"), "Include config").unwrap();
        assert!(read_directives(&ssh.join("config"), &home, 0, &mut 0, &mut Vec::new()).is_err());
        std::fs::remove_dir_all(home).unwrap();
    }
}
