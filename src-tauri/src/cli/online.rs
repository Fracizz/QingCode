//! Online commands: talk to a running QingCode GUI via local IPC.

use super::args::RunWait;
use super::output::{self, EXIT_APP_NOT_RUNNING, EXIT_ERROR, EXIT_TIMEOUT};
use super::paths;
use crate::ipc::{self, ClientError, IpcRequest};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// `--wait-text` 只在最近这些行里匹配，足以覆盖启动日志，又不会每次轮询都传完整历史。
const WAIT_TEXT_TAIL_LINES: u32 = 2_000;

fn request(op: &str) -> IpcRequest {
    IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: op.into(),
        ..Default::default()
    }
}

fn scoped(op: &str, project: Option<&str>, config: Option<&str>) -> IpcRequest {
    IpcRequest {
        project: project.map(str::to_string),
        config: config.map(str::to_string),
        ..request(op)
    }
}

fn exit_for(error: ClientError) -> i32 {
    match error {
        ClientError::AppNotRunning(message) => output::fail(EXIT_APP_NOT_RUNNING, message),
        ClientError::Timeout(message) => output::fail(EXIT_TIMEOUT, message),
        ClientError::Other(message) => output::fail(EXIT_ERROR, message),
    }
}

/// GUI 比 CLI 旧时只会返回 `unknown op`，补一句原因，避免调用方去排查命令本身。
fn explain_failure(error: String) -> String {
    if error.contains("unknown op") {
        format!("{error} (the running QingCode is older than this CLI; restart it after updating)")
    } else {
        error
    }
}

/// 发送请求并取出 `data`；失败时已输出错误，`Err` 里是退出码。
fn call(req: &IpcRequest) -> Result<Value, i32> {
    match ipc::client_request(req) {
        Ok(resp) if resp.ok => Ok(resp.data.unwrap_or(Value::Null)),
        Ok(resp) => Err(output::fail(
            EXIT_ERROR,
            explain_failure(resp.error.unwrap_or_else(|| "request failed".into())),
        )),
        Err(error) => Err(exit_for(error)),
    }
}

fn dispatch(req: IpcRequest) -> i32 {
    match call(&req) {
        Ok(data) => output::ok(data),
        Err(code) => code,
    }
}

fn current_dir() -> Result<PathBuf, i32> {
    std::env::current_dir().map_err(|e| output::fail(EXIT_ERROR, format!("current dir: {e}")))
}

pub fn version() -> i32 {
    output::ok(cli_identity())
}

fn cli_identity() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": ipc::PROTOCOL_VERSION,
        "debug": cfg!(debug_assertions),
    })
}

pub fn status() -> i32 {
    let info = match ipc::client_request(&request("app.info")) {
        Ok(resp) if resp.ok => resp.data.unwrap_or(Value::Null),
        // 旧版 GUI 把未知 op 转给前端并报错，说明应用在运行但版本不匹配。
        Ok(_) => Value::Null,
        Err(error) => return exit_for(error),
    };
    let ui_ready = info
        .get("uiReady")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let workspace = if ui_ready {
        match call(&request("app.status")) {
            Ok(data) => data,
            Err(code) => return code,
        }
    } else {
        Value::Null
    };
    let compatible =
        info.get("protocol").and_then(Value::as_u64) == Some(u64::from(ipc::PROTOCOL_VERSION));
    output::ok(json!({
        "running": true,
        "cli": cli_identity(),
        "app": info,
        "compatible": compatible,
        "workspace": workspace,
    }))
}

pub fn settings_reset(scope: &str, project: Option<&str>) -> i32 {
    dispatch(scoped("settings.reset", project, Some(scope)))
}

pub fn settings_import(scope: &str, project: Option<&str>, content: String) -> i32 {
    dispatch(IpcRequest {
        content: Some(content),
        ..scoped("settings.import", project, Some(scope))
    })
}

pub fn settings_export(scope: &str, project: Option<&str>, destination: Option<&str>) -> i32 {
    let data = match call(&scoped("settings.export", project, Some(scope))) {
        Ok(data) => data,
        Err(code) => return code,
    };
    let Some(destination) = destination else {
        return output::ok(data);
    };
    // Do not overwrite an existing file from an automation command.
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| format!("create {destination}: {e}"))?;
        writeln!(file, "{content}").map_err(|e| format!("write {destination}: {e}"))
    })();
    match result {
        Ok(()) => output::ok(json!({ "path": destination, "scope": scope })),
        Err(e) => output::fail(EXIT_ERROR, e),
    }
}

fn notify(req: &IpcRequest) -> &'static str {
    match ipc::client_request(req) {
        Ok(response) if response.ok => "reloaded",
        Err(ClientError::AppNotRunning(_)) => "not_running",
        _ => "reload_failed",
    }
}

/// 项目已写入数据库后通知运行中的 GUI 刷新；GUI 未运行时下次启动会读到新数据，不算失败。
pub fn notify_projects_changed() -> &'static str {
    notify(&request("projects.reload"))
}

/// 本地 run.json 被 CLI 改写后刷新 GUI 缓存，否则 GUI 下一次保存会用旧内容覆盖。
pub fn notify_run_configs_changed(project_id: &str) -> &'static str {
    notify(&scoped("run.reload", Some(project_id), None))
}

pub fn project_switch(query: &str) -> i32 {
    dispatch(scoped("project.switch", Some(query), None))
}

fn task_options(task: Option<&str>) -> Option<Value> {
    task.map(|task| json!({ "task": task }))
}

pub fn run_start(
    query: &str,
    project: Option<&str>,
    task: Option<&str>,
    wait: Option<RunWait>,
) -> i32 {
    // 带任务筛选时用独立 op：旧版 GUI 会忽略 options，同名 op 会把整个配置都启动。
    let op = if task.is_some() {
        "run.task.start"
    } else {
        "run.start"
    };
    let req = IpcRequest {
        options: task_options(task),
        ..scoped(op, project, Some(query))
    };
    let Some(wait) = wait else {
        return dispatch(req);
    };
    match call(&req) {
        Ok(started) => wait_until_ready(query, project, started, &wait),
        Err(code) => code,
    }
}

fn wait_until_ready(query: &str, project: Option<&str>, started: Value, wait: &RunWait) -> i32 {
    // 用启动时解析出的项目继续轮询，等待期间切换 GUI 当前项目不影响结果。
    let resolved = started.get("project").and_then(Value::as_str);
    let project = resolved.or(project);
    let terminal_ids = started_terminal_ids(&started);
    let tail = if wait.text.is_some() {
        WAIT_TEXT_TAIL_LINES
    } else {
        1
    };
    let begin = Instant::now();
    let timeout = Duration::from_secs(wait.timeout_secs);
    loop {
        let req = IpcRequest {
            options: Some(json!({ "tail": tail })),
            ..scoped("run.logs", project, Some(query))
        };
        let logs = match call(&req) {
            Ok(logs) => logs,
            Err(code) => return code,
        };
        let tasks = started_tasks(&logs, &terminal_ids);
        let summary = task_summaries(&tasks);
        match evaluate_wait(&tasks, wait.text.as_deref()) {
            WaitState::Ready => {
                let mut data = started;
                data["wait"] = json!({
                    "ready": true,
                    "elapsedMs": begin.elapsed().as_millis() as u64,
                    "tasks": summary,
                });
                return output::ok(data);
            }
            WaitState::Failed(reason) => {
                return output::fail_with_data(EXIT_ERROR, reason, json!({ "tasks": summary }));
            }
            WaitState::Pending if begin.elapsed() >= timeout => {
                return output::fail_with_data(
                    EXIT_TIMEOUT,
                    format!(
                        "tasks were not ready within {}s; they keep running in QingCode",
                        wait.timeout_secs
                    ),
                    json!({ "tasks": summary }),
                );
            }
            WaitState::Pending => std::thread::sleep(WAIT_POLL_INTERVAL),
        }
    }
}

fn started_terminal_ids(started: &Value) -> Vec<String> {
    started
        .get("tasks")
        .and_then(Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .filter_map(|task| task.get("terminalId")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn started_tasks(logs: &Value, terminal_ids: &[String]) -> Vec<Value> {
    logs.get("tasks")
        .and_then(Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .filter(|task| {
                    task.get("terminalId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| terminal_ids.iter().any(|known| known == id))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// 超时和失败时只回传状态，不带终端内容。
fn task_summaries(tasks: &[Value]) -> Vec<Value> {
    tasks
        .iter()
        .map(|task| {
            json!({
                "id": task.get("id"),
                "terminalId": task.get("terminalId"),
                "status": task.get("status"),
                "exitCode": task.get("exitCode"),
            })
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum WaitState {
    Pending,
    Ready,
    Failed(String),
}

fn task_status(task: &Value) -> &str {
    task.get("status").and_then(Value::as_str).unwrap_or("")
}

fn evaluate_wait(tasks: &[Value], text: Option<&str>) -> WaitState {
    if tasks.is_empty() {
        return WaitState::Pending;
    }
    for task in tasks {
        if task_status(task) == "exited" && task.get("exitCode").and_then(Value::as_i64) != Some(0)
        {
            let id = task.get("id").and_then(Value::as_str).unwrap_or("task");
            let code = task.get("exitCode").cloned().unwrap_or(Value::Null);
            return WaitState::Failed(format!("task {id} exited with code {code}"));
        }
    }
    let all_exited = tasks.iter().all(|task| task_status(task) == "exited");
    match text {
        Some(needle) => {
            let found = tasks.iter().any(|task| {
                task.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|output| output.contains(needle))
            });
            if found {
                WaitState::Ready
            } else if all_exited {
                WaitState::Failed(format!("tasks exited before printing: {needle}"))
            } else {
                WaitState::Pending
            }
        }
        None => {
            let settled = tasks
                .iter()
                .all(|task| matches!(task_status(task), "running" | "exited"));
            if settled {
                WaitState::Ready
            } else {
                WaitState::Pending
            }
        }
    }
}

pub fn run_stop(query: &str, project: Option<&str>, task: Option<&str>) -> i32 {
    let op = if task.is_some() {
        "run.task.stop"
    } else {
        "run.stop"
    };
    dispatch(IpcRequest {
        options: task_options(task),
        ..scoped(op, project, Some(query))
    })
}

pub fn run_restart(query: &str, project: Option<&str>, task: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        options: task_options(task),
        ..scoped("run.restart", project, Some(query))
    })
}

pub fn run_logs(query: &str, project: Option<&str>, task: Option<&str>, tail: Option<u32>) -> i32 {
    dispatch(IpcRequest {
        options: Some(json!({ "task": task, "tail": tail })),
        ..scoped("run.logs", project, Some(query))
    })
}

pub fn run_status(project: Option<&str>) -> i32 {
    dispatch(scoped("run.status", project, None))
}

pub fn run_list(project: Option<&str>) -> i32 {
    dispatch(scoped("run.list", project, None))
}

pub fn run_get(query: &str, project: Option<&str>) -> i32 {
    dispatch(scoped("run.get", project, Some(query)))
}

pub fn run_upsert(content: String, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        content: Some(content),
        ..scoped("run.upsert", project, None)
    })
}

pub fn run_remove(query: &str, project: Option<&str>) -> i32 {
    dispatch(scoped("run.remove", project, Some(query)))
}

pub fn terminal_list(project: Option<&str>) -> i32 {
    dispatch(scoped("terminal.list", project, None))
}

pub fn terminal_read(
    query: &str,
    project: Option<&str>,
    scope: Option<&str>,
    tail: Option<u32>,
) -> i32 {
    dispatch(IpcRequest {
        options: Some(json!({ "scope": scope, "tail": tail })),
        ..scoped("terminal.read", project, Some(query))
    })
}

/// 终端里回车键发送的是 CR；`\n` 在 TUI 中可能只是换行而不是提交。
pub fn terminal_payload(mut text: String, enter: bool) -> String {
    if enter {
        text.push('\r');
    }
    text
}

pub fn terminal_send(query: &str, project: Option<&str>, data: String) -> i32 {
    dispatch(IpcRequest {
        content: Some(data),
        ..scoped("terminal.send", project, Some(query))
    })
}

pub fn terminal_create(project: Option<&str>) -> i32 {
    dispatch(scoped("terminal.create", project, None))
}

pub fn terminal_close(query: &str, project: Option<&str>) -> i32 {
    dispatch(scoped("terminal.close", project, Some(query)))
}

pub fn terminal_restart(query: &str, project: Option<&str>) -> i32 {
    dispatch(scoped("terminal.restart", project, Some(query)))
}

pub fn trust_grant(path: &str) -> i32 {
    let cwd = match current_dir() {
        Ok(cwd) => cwd,
        Err(code) => return code,
    };
    let path = match paths::existing_directory(path, &cwd) {
        Ok(path) => path,
        Err(error) => return output::fail(EXIT_ERROR, error),
    };
    dispatch(IpcRequest {
        path: Some(path),
        ..request("trust.grant")
    })
}

pub fn trust_revoke(path: &str) -> i32 {
    let cwd = match current_dir() {
        Ok(cwd) => cwd,
        Err(code) => return code,
    };
    dispatch(IpcRequest {
        path: Some(paths::absolute_path(path, &cwd)),
        ..request("trust.revoke")
    })
}

pub fn trust_list() -> i32 {
    dispatch(request("trust.list"))
}

pub fn open(targets: &[String]) -> i32 {
    let cwd = match current_dir() {
        Ok(cwd) => cwd,
        Err(code) => return code,
    };
    dispatch(IpcRequest {
        paths: Some(
            targets
                .iter()
                .map(|target| paths::absolutize_open_target(target, &cwd))
                .collect(),
        ),
        ..request("open")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_payload_appends_cr_only_when_enter_is_requested() {
        assert_eq!(terminal_payload("ls".into(), false), "ls");
        assert_eq!(terminal_payload("ls".into(), true), "ls\r");
        assert_eq!(terminal_payload(String::new(), true), "\r");
        assert_eq!(terminal_payload("a\nb\n".into(), false), "a\nb\n");
    }

    fn task(status: &str, exit_code: Value, text: &str) -> Value {
        json!({ "id": "api", "terminalId": "t1", "status": status, "exitCode": exit_code, "text": text })
    }

    #[test]
    fn wait_without_text_needs_every_task_started() {
        assert_eq!(evaluate_wait(&[], None), WaitState::Pending);
        assert_eq!(
            evaluate_wait(&[task("starting", Value::Null, "")], None),
            WaitState::Pending
        );
        assert_eq!(
            evaluate_wait(
                &[
                    task("running", Value::Null, ""),
                    task("starting", Value::Null, "")
                ],
                None
            ),
            WaitState::Pending
        );
        assert_eq!(
            evaluate_wait(&[task("running", Value::Null, "")], None),
            WaitState::Ready
        );
        assert_eq!(
            evaluate_wait(&[task("exited", json!(0), "")], None),
            WaitState::Ready
        );
    }

    #[test]
    fn wait_fails_when_a_task_exits_unsuccessfully() {
        for tasks in [
            vec![task("exited", json!(1), "")],
            vec![
                task("running", Value::Null, ""),
                task("exited", Value::Null, ""),
            ],
        ] {
            assert!(matches!(
                evaluate_wait(&tasks, Some("ready")),
                WaitState::Failed(_)
            ));
        }
    }

    #[test]
    fn wait_text_is_matched_in_any_task_output() {
        let running = task("running", Value::Null, "booting");
        assert_eq!(
            evaluate_wait(std::slice::from_ref(&running), Some("ready")),
            WaitState::Pending
        );
        assert_eq!(
            evaluate_wait(
                &[running, task("running", Value::Null, "server ready")],
                Some("ready")
            ),
            WaitState::Ready
        );
    }

    #[test]
    fn wait_text_fails_once_all_tasks_finished_without_it() {
        assert!(matches!(
            evaluate_wait(&[task("exited", json!(0), "done")], Some("ready")),
            WaitState::Failed(_)
        ));
    }

    #[test]
    fn wait_only_considers_terminals_from_this_start() {
        let logs = json!({ "tasks": [
            { "terminalId": "old", "status": "exited", "exitCode": 1 },
            { "terminalId": "new", "status": "running", "exitCode": null },
        ]});
        let selected = started_tasks(&logs, &["new".to_string()]);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["terminalId"], "new");
        assert_eq!(
            started_terminal_ids(&json!({ "tasks": [{ "id": "a", "terminalId": "new" }] })),
            vec!["new".to_string()]
        );
    }

    #[test]
    fn task_summaries_do_not_carry_terminal_output() {
        let summary = task_summaries(&[task("running", Value::Null, "secret-output")]);
        assert!(!summary[0].to_string().contains("secret-output"));
    }

    #[test]
    fn unknown_op_failures_explain_the_version_mismatch() {
        assert!(explain_failure("Error: unknown op: run.logs".into()).contains("older than"));
        assert_eq!(explain_failure("boom".into()), "boom");
    }
}
