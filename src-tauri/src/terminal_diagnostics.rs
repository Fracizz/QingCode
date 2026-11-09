//! Desktop lifecycle journal. Payloads are a fixed metadata schema, not a console log.
use qingcode_server::diagnostics;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendEvent {
    event: String,
    terminal_id: String,
    pty_id: Option<String>,
    connection_id: Option<String>,
    operation_id: Option<String>,
    source: Option<String>,
    exit_code: Option<i64>,
}

#[tauri::command]
pub fn terminal_diagnostic_event(event: FrontendEvent) -> Result<(), String> {
    if !matches!(
        event.event.as_str(),
        "terminal.exit_received"
            | "terminal.close_requested"
            | "terminal.restart_requested"
            | "terminal.restore_failed"
            | "terminal.spawned"
            | "terminal.export_requested"
    ) || diagnostics::identifier(Some(&event.terminal_id)).is_none()
    {
        return Err("无效的终端诊断事件".into());
    }
    let incident = event.event == "terminal.restore_failed"
        || (event.event == "terminal.exit_received" && event.exit_code != Some(0));
    diagnostics::record(
        &event.event,
        json!({
            "terminalId":event.terminal_id,
            "ptyId":diagnostics::identifier(event.pty_id.as_deref()),
            "connectionId":diagnostics::identifier(event.connection_id.as_deref()),
            "operationId":diagnostics::identifier(event.operation_id.as_deref()),
            "source":diagnostics::termination_source(event.source.as_deref()),
            "exitCode":event.exit_code,
        }),
        incident,
        incident,
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshOpenEvent {
    project_id: String,
    connection_id: Option<String>,
    warmup: String,
    warmup_detail: Option<String>,
    reused: bool,
    outcome: String,
    warmup_ms: u64,
    connect_ms: u64,
    prepare_ms: u64,
    files_ms: u64,
}

/// 记录一次远程项目打开是否命中后台预热及各阶段耗时。预热错误只保留
/// `error_summary` 处理后的摘要，其余字段都是固定枚举、标识符或数字。
#[tauri::command]
pub fn ssh_open_diagnostic_event(event: SshOpenEvent) -> Result<(), String> {
    if !matches!(
        event.warmup.as_str(),
        "none" | "queued" | "preparing" | "ready" | "attention" | "failed"
    ) || !matches!(event.outcome.as_str(), "opened" | "failed" | "cancelled")
        || diagnostics::identifier(Some(&event.project_id)).is_none()
    {
        return Err("无效的远程项目打开诊断事件".into());
    }
    diagnostics::record(
        "ssh.project_open",
        json!({
            "projectId":event.project_id,
            "connectionId":diagnostics::identifier(event.connection_id.as_deref()),
            "warmup":event.warmup,
            "warmupDetail":event.warmup_detail.as_deref().map(diagnostics::error_summary),
            "reused":event.reused,
            "outcome":event.outcome,
            "warmupMs":event.warmup_ms,
            "connectMs":event.connect_ms,
            "prepareMs":event.prepare_ms,
            "filesMs":event.files_ms,
        }),
        false,
        false,
    );
    Ok(())
}

#[tauri::command]
pub fn terminal_diagnostic_log() -> Result<String, String> {
    diagnostics::export()
}
