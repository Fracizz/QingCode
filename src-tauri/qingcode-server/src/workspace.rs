//! Authenticated direct workspace operations. Network connections never own PTYs.
//! Every file handle is scoped to a canonical project root, bounded and expiring.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

const CHUNK: usize = 256 * 1024;
const HANDLE_LIMIT: usize = 256;
struct OpenFile {
    file: File,
    root: PathBuf,
    writable: bool,
    touched: Instant,
}
static FILES: OnceLock<Mutex<HashMap<String, OpenFile>>> = OnceLock::new();

fn files() -> &'static Mutex<HashMap<String, OpenFile>> {
    FILES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数 {key}"))
}
fn native(value: &str) -> PathBuf {
    #[cfg(windows)]
    let value = if value.starts_with('/') && value.as_bytes().get(2) == Some(&b':') {
        &value[1..]
    } else {
        value
    };
    PathBuf::from(value)
}
fn display(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let value = if let Some(unc) = value.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        value.strip_prefix("//?/").unwrap_or(&value).to_string()
    };
    if value.as_bytes().get(1) == Some(&b':') {
        format!("/{value}")
    } else {
        value
    }
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("无法解析路径: {e}"))
}
fn root(v: &Value) -> Result<Option<PathBuf>, String> {
    v.get("root")
        .and_then(Value::as_str)
        .map(|value| {
            let requested = native(value);
            if !requested.is_absolute() {
                return Err("项目根必须是绝对路径".into());
            }
            let physical = canonical(&requested)?;
            let expected = display(&requested);
            let actual = display(&physical);
            #[cfg(windows)]
            let unchanged = expected
                .trim_end_matches('/')
                .eq_ignore_ascii_case(actual.trim_end_matches('/'));
            #[cfg(not(windows))]
            let unchanged = expected.trim_end_matches('/') == actual.trim_end_matches('/');
            if !unchanged {
                return Err("项目根身份已变化或被替换为链接，请重新打开项目".into());
            }
            Ok(physical)
        })
        .transpose()
}

/// Check the lexical path before following links, then check the physical path.
fn checked(v: &Value, key: &str, missing: bool, leaf_link: bool) -> Result<PathBuf, String> {
    let input = field(v, key)?;
    if input.contains('\0') {
        return Err("路径包含无效字符".into());
    }
    let path = native(input);
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("路径不允许包含 ..".into());
    }
    let Some(root) = root(v)? else {
        return canonical(&path);
    };
    let path = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    // Compare canonical parents so Windows extended prefixes remain equivalent.
    let leaf = path.file_name();
    let probe_parent = missing || leaf_link;
    let checked_path = if let Some(leaf) = leaf.filter(|_| probe_parent && path != root) {
        let parent = canonical(path.parent().ok_or("路径没有父目录")?)?;
        if !crate::path_is_within(&parent, &root) {
            return Err("路径通过链接越出项目根".into());
        }
        parent.join(leaf)
    } else {
        canonical(&path)?
    };
    if !crate::path_is_within(&checked_path, &root) {
        return Err("路径越出项目根".into());
    }
    if checked_path.exists() && !leaf_link {
        let physical = canonical(&checked_path)?;
        if !crate::path_is_within(&physical, &root) {
            return Err("路径通过链接越出项目根".into());
        }
    }
    Ok(checked_path)
}
fn writable(v: &Value) -> Result<(), String> {
    if root(v)?.is_none() || v.get("trusted").and_then(Value::as_bool) != Some(true) {
        return Err("项目未信任，不能修改文件或运行命令".into());
    }
    Ok(())
}
fn attributes(meta: &std::fs::Metadata) -> Value {
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    };
    #[cfg(not(unix))]
    let permissions = (if meta.file_type().is_symlink() {
        0xa000
    } else if meta.is_dir() {
        0x4000
    } else {
        0x8000
    }) | if meta.permissions().readonly() {
        0o444
    } else {
        0o644
    };
    let seconds = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
    };
    json!({"size":meta.len(),"permissions":permissions,"atime":seconds(meta.accessed()),"mtime":seconds(meta.modified())})
}
fn with_handle<T>(
    v: &Value,
    write: bool,
    f: impl FnOnce(&mut File) -> Result<T, String>,
) -> Result<T, String> {
    if write {
        writable(v)?;
    }
    let expected = root(v)?.ok_or("文件句柄需要项目根")?;
    let mut files = files().lock().map_err(|_| "文件句柄状态不可用")?;
    let handle = files
        .get_mut(field(v, "handle")?)
        .ok_or("文件句柄不存在或已过期")?;
    if handle.root != expected || (write && !handle.writable) {
        return Err("文件句柄不属于当前项目或不可写".into());
    }
    handle.touched = Instant::now();
    f(&mut handle.file)
}

pub async fn handle(v: Value) -> Result<Value, String> {
    if v.get("op").and_then(Value::as_str) == Some("exec") {
        return execute(v).await;
    }
    tokio::task::spawn_blocking(move || handle_sync(v))
        .await
        .map_err(|_| "工作区操作失败".to_string())?
}
fn handle_sync(v: Value) -> Result<Value, String> {
    let op = field(&v, "op")?;
    match op {
        "info" => {
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("无法确定家目录")?;
            Ok(json!({"homePath":display(&PathBuf::from(home)),"os":std::env::consts::OS}))
        }
        "canonicalize" => Ok(json!(display(&checked(&v, "path", false, false)?))),
        "exists" => match checked(&v, "path", true, false) {
            Ok(path) => Ok(json!(path.try_exists().map_err(|e| e.to_string())?)),
            Err(error) => Err(error),
        },
        "metadata" | "symlink_metadata" => {
            let path = checked(&v, "path", false, op == "symlink_metadata")?;
            let meta = if op == "symlink_metadata" {
                std::fs::symlink_metadata(path)
            } else {
                std::fs::metadata(path)
            }
            .map_err(|e| e.to_string())?;
            Ok(attributes(&meta))
        }
        "read_dir" => {
            let path = checked(&v, "path", false, false)?;
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":display(&entry.path()),"attributes":attributes(&meta)}));
                if entries.len() > 50000 {
                    return Err("单层目录条目过多，请缩小范围".into());
                }
            }
            Ok(json!(entries))
        }
        "read_link" => Ok(json!(display(
            &std::fs::read_link(checked(&v, "path", false, true)?).map_err(|e| e.to_string())?
        ))),
        "open" => {
            let project = root(&v)?.ok_or("读取文件需要已注册项目根")?;
            let flags = v["flags"].as_u64().unwrap_or(1);
            if flags & !63 != 0 || flags == 0 {
                return Err("文件打开标记无效".into());
            }
            let writing = flags & (2 | 4 | 8 | 16 | 32) != 0;
            if writing {
                writable(&v)?;
            }
            let path = checked(&v, "path", flags & 8 != 0, false)?;
            let mut options = OpenOptions::new();
            options
                .read(flags & 1 != 0)
                .write(flags & 2 != 0)
                .append(flags & 4 != 0)
                .create(flags & 8 != 0)
                .truncate(flags & 16 != 0)
                .create_new(flags & 8 != 0 && flags & 32 != 0);
            let file = options.open(path).map_err(|e| e.to_string())?;
            let size = file.metadata().map_err(|e| e.to_string())?.len();
            let mut files = files().lock().map_err(|_| "文件句柄状态不可用")?;
            files.retain(|_, handle| handle.touched.elapsed() < Duration::from_secs(300));
            if files.len() >= HANDLE_LIMIT {
                return Err("打开文件过多，请稍后重试".into());
            }
            let handle = crate::generate_token();
            files.insert(
                handle.clone(),
                OpenFile {
                    file,
                    root: project,
                    writable: writing,
                    touched: Instant::now(),
                },
            );
            Ok(json!({"handle":handle,"size":size}))
        }
        "read_at" => with_handle(&v, false, |file| {
            let length = v["length"]
                .as_u64()
                .unwrap_or(CHUNK as u64)
                .min(CHUNK as u64) as usize;
            file.seek(SeekFrom::Start(v["offset"].as_u64().unwrap_or(0)))
                .map_err(|e| e.to_string())?;
            let mut bytes = vec![0; length];
            let read = file.read(&mut bytes).map_err(|e| e.to_string())?;
            bytes.truncate(read);
            Ok(json!(bytes))
        }),
        "write_at" => {
            let data: Vec<u8> =
                serde_json::from_value(v["data"].clone()).map_err(|_| "文件字节无效")?;
            if data.len() > CHUNK {
                return Err("文件块过大".into());
            }
            with_handle(&v, true, |file| {
                file.seek(SeekFrom::Start(v["offset"].as_u64().unwrap_or(0)))
                    .map_err(|e| e.to_string())?;
                file.write_all(&data).map_err(|e| e.to_string())?;
                Ok(json!(data.len()))
            })
        }
        "metadata_handle" => with_handle(&v, false, |file| {
            file.metadata()
                .map(|m| attributes(&m))
                .map_err(|e| e.to_string())
        }),
        "close" => {
            let expected = root(&v)?.ok_or("文件句柄需要项目根")?;
            let mut files = files().lock().map_err(|_| "文件句柄状态不可用")?;
            let id = field(&v, "handle")?;
            if files.get(id).is_some_and(|h| h.root != expected) {
                return Err("文件句柄不属于当前项目".into());
            }
            if let Some(handle) = files.remove(id) {
                if handle.writable {
                    handle.file.sync_all().map_err(|e| e.to_string())?;
                }
            }
            Ok(Value::Null)
        }
        "create_dir" | "remove_dir" | "remove_file" | "rename" | "set_metadata" | "symlink" => {
            writable(&v)?;
            let path = checked(
                &v,
                "path",
                matches!(op, "create_dir" | "rename" | "symlink"),
                matches!(op, "remove_file" | "remove_dir"),
            )?;
            if root(&v)?.as_ref() == Some(&path) {
                return Err("不能删除或替换项目根目录".into());
            }
            match op {
                "create_dir" => std::fs::create_dir(path).map_err(|e| e.to_string())?,
                "remove_dir" => std::fs::remove_dir(path).map_err(|e| e.to_string())?,
                "remove_file" => std::fs::remove_file(path).map_err(|e| e.to_string())?,
                "rename" => {
                    let dest = checked(&v, "newPath", true, false)?;
                    std::fs::rename(path, dest).map_err(|e| e.to_string())?;
                }
                "set_metadata" => {
                    let file = OpenOptions::new()
                        .read(true)
                        .open(&path)
                        .map_err(|e| e.to_string())?;
                    let attrs = &v["attrs"];
                    #[cfg(unix)]
                    if let Some(mode) = attrs["permissions"].as_u64() {
                        use std::os::unix::fs::PermissionsExt;
                        file.set_permissions(std::fs::Permissions::from_mode(mode as u32 & 0o777))
                            .map_err(|e| e.to_string())?;
                    }
                    let mut times = std::fs::FileTimes::new();
                    if let Some(time) = attrs["mtime"].as_u64() {
                        times = times.set_modified(UNIX_EPOCH + Duration::from_secs(time));
                    }
                    if let Some(time) = attrs["atime"].as_u64() {
                        times = times.set_accessed(UNIX_EPOCH + Duration::from_secs(time));
                    }
                    file.set_times(times).map_err(|e| e.to_string())?;
                }
                "symlink" => {
                    let target = checked(&v, "target", false, false)?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(target, path).map_err(|e| e.to_string())?;
                    #[cfg(windows)]
                    {
                        if target.is_dir() {
                            std::os::windows::fs::symlink_dir(target, path)
                        } else {
                            std::os::windows::fs::symlink_file(target, path)
                        }
                        .map_err(|e| e.to_string())?;
                    }
                }
                _ => unreachable!(),
            }
            Ok(Value::Null)
        }
        _ => Err("不支持的工作区操作".into()),
    }
}

async fn execute(v: Value) -> Result<Value, String> {
    use std::process::Stdio;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    writable(&v)?;
    let cwd = checked(&v, "path", false, false)?;
    let script = field(&v, "command")?;
    if script.len() > 1024 * 1024 {
        return Err("命令过长".into());
    }
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.args(["/D", "/S", "/C", script]);
        c
    } else {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.args(["-c", script]);
        c
    };
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| format!("启动命令失败: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("命令输入不可用")?;
    let mut stdout = child.stdout.take().ok_or("命令输出不可用")?;
    let mut stderr = child.stderr.take().ok_or("命令错误输出不可用")?;
    let input: Vec<u8> = serde_json::from_value(v.get("input").cloned().unwrap_or(json!([])))
        .map_err(|_| "命令输入无效")?;
    if input.len() > 1024 * 1024 {
        return Err("命令输入过大".into());
    }
    let timeout = Duration::from_secs(v["timeoutSeconds"].as_u64().unwrap_or(120).clamp(1, 600));
    let collected=tokio::time::timeout(timeout,async{
        let input_task=async move { stdin.write_all(&input).await?; stdin.shutdown().await?; drop(stdin); Ok::<(),std::io::Error>(()) };
        let output_task=async{let mut data=Vec::new();(&mut stdout).take(4*1024*1024+1).read_to_end(&mut data).await?;Ok::<_,std::io::Error>(data)};
        let error_task=async{let mut data=Vec::new();(&mut stderr).take(4*1024*1024+1).read_to_end(&mut data).await?;Ok::<_,std::io::Error>(data)};
        let (_,out,err)=tokio::try_join!(input_task,output_task,error_task).map_err(|e|e.to_string())?;
        if out.len()>4*1024*1024||err.len()>4*1024*1024{return Err("命令输出过大".into());}
        let status=child.wait().await.map_err(|e|e.to_string())?;
        Ok::<_,String>(json!({"stdout":String::from_utf8_lossy(&out),"stderr":String::from_utf8_lossy(&err),"exit_code":status.code().unwrap_or(255)}))
    }).await.map_err(|_|"远程命令超时，已中止".to_string())?;
    collected
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_registered_root_replaced_with_an_outside_symlink() {
        let base = std::env::temp_dir().join(format!(
            "qingcode-root-identity-{}",
            crate::generate_token()
        ));
        let root = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("file"), b"original").unwrap();
        std::fs::write(outside.join("file"), b"private").unwrap();
        let registered = display(&canonical(&root).unwrap());
        std::fs::rename(&root, base.join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        let error = handle(
            json!({"op":"open","root":registered,"path":display(&root.join("file")),"flags":1}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("项目根身份已变化"));
        std::fs::remove_dir_all(base).unwrap();
    }
    #[tokio::test]
    async fn rejects_escape_and_untrusted_writes_and_scopes_open_handles() {
        let base =
            std::env::temp_dir().join(format!("qingcode-direct-fs-{}", crate::generate_token()));
        let project = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("file"), b"hello").unwrap();
        let request = json!({"root":display(&project),"path":display(&project.join("file")),"op":"open","flags":1});
        let opened = handle(request.clone()).await.unwrap();
        let id = opened["handle"].as_str().unwrap();
        assert_eq!(
            handle(json!({"root":display(&project),"op":"read_at","handle":id,"length":5}))
                .await
                .unwrap(),
            json!([104, 101, 108, 108, 111])
        );
        assert!(
            handle(json!({"root":display(&outside),"op":"read_at","handle":id,"length":5}))
                .await
                .is_err()
        );
        assert!(handle(json!({"root":display(&project),"path":display(&project.join("new")),"op":"open","flags":26})).await.is_err());
        assert!(
            handle(json!({"root":display(&project),"path":display(&outside),"op":"metadata"}))
                .await
                .is_err()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, project.join("escape")).unwrap();
            assert!(handle(json!({"root":display(&project),"path":display(&project.join("escape/secret")),"trusted":true,"op":"open","flags":26})).await.is_err());
        }
        handle(json!({"root":display(&project),"op":"close","handle":id}))
            .await
            .unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_display_tests {
    use super::*;
    #[test]
    fn display_preserves_unc_roots_when_removing_windows_extended_prefix() {
        assert_eq!(
            display(Path::new(r"\\?\UNC\server\share\project")),
            "//server/share/project"
        );
        assert_eq!(display(Path::new(r"\\?\D:\project")), "/D:/project");
        assert_eq!(
            display(Path::new(r"\\server\share\project")),
            "//server/share/project"
        );
    }
}
