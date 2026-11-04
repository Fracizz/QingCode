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

#[tauri::command]
pub fn terminal_diagnostic_log() -> Result<String, String> {
    diagnostics::export()
}
