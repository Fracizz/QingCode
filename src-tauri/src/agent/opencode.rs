//! OpenCode：`opencode acp`（Agent Client Protocol，JSON-RPC 2.0 逐行收发）。
//!
//! 启动时通过 `OPENCODE_CONFIG_CONTENT` 让编辑、命令和联网都先询问，再由电脑端按当前
//! 安全选项自动放行或转给手机审批，切换安全选项无需重启 OpenCode。
use std::collections::HashMap;

use serde_json::{json, Value};

use super::process::Launch;
use super::thread::{clip_tail, Status, MAX_TOOL_OUTPUT};
use super::{approval_item, approval_resolved, str_at, Adapter, Cx, Prompt};

pub const SAFETY: &[(&str, &str, &str)] = &[
    ("ask", "每次询问", "编辑文件、运行命令和联网前在手机上确认"),
    (
        "edits",
        "自动编辑",
        "自动接受文件编辑；运行命令和联网前在手机上确认",
    ),
    ("full", "完全访问", "不再询问，直接编辑文件、运行命令和联网"),
];
pub const DEFAULT_SAFETY: &str = "ask";

/// 只读类工具直接放行，其余交给宿主决定。
const PERMISSION_CONFIG: &str = r#"{"permission":{"*":"ask","read":"allow","glob":"allow","grep":"allow","list":"allow","lsp":"allow","todowrite":"allow","todoread":"allow","skill":"allow","task":"allow"}}"#;

enum Pending {
    Initialize,
    Session { resumed: bool },
    Prompt,
    Config,
}

pub struct Opencode {
    cwd: String,
    safety: String,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
    session: Option<String>,
    can_resume: bool,
    can_load: bool,
    /// `session/load` 会重放历史；回放期间忽略更新，避免重复条目。
    replaying: bool,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    ready: bool,
    queue: Vec<Prompt>,
    prompting: usize,
    turn: u64,
    /// 当前正在追加的文本段（条目 kind, 条目 id）。
    segment: Option<(&'static str, String)>,
    requests: HashMap<String, (Value, Vec<Value>)>,
}

impl Opencode {
    pub fn new(
        cwd: String,
        safety: String,
        model: Option<String>,
        effort: Option<String>,
        mode: Option<String>,
        session: Option<String>,
    ) -> Self {
        Self {
            cwd,
            safety,
            model,
            effort,
            mode,
            session,
            can_resume: false,
            can_load: false,
            replaying: false,
            next_id: 0,
            pending: HashMap::new(),
            ready: false,
            queue: Vec::new(),
            prompting: 0,
            turn: 0,
            segment: None,
            requests: HashMap::new(),
        }
    }

    fn request(&mut self, cx: &mut Cx, method: &str, params: Value, pending: Pending) {
        self.next_id += 1;
        self.pending.insert(self.next_id, pending);
        cx.send(
            json!({ "jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params }),
        );
    }

    fn open_session(&mut self, cx: &mut Cx) {
        match self.session.clone() {
            Some(session) if self.can_resume || self.can_load => {
                let method = if self.can_resume {
                    "session/resume"
                } else {
                    "session/load"
                };
                self.replaying = !self.can_resume;
                self.request(
                    cx,
                    method,
                    json!({ "sessionId": session, "cwd": self.cwd, "mcpServers": [] }),
                    Pending::Session { resumed: true },
                );
            }
            _ => self.request(
                cx,
                "session/new",
                json!({ "cwd": self.cwd, "mcpServers": [] }),
                Pending::Session { resumed: false },
            ),
        }
    }

    fn set_config(&mut self, cx: &mut Cx, id: &str, value: &str) {
        if let Some(session) = self.session.clone() {
            self.request(
                cx,
                "session/set_config_option",
                json!({ "sessionId": session, "configId": id, "value": value }),
                Pending::Config,
            );
        }
    }

    /// 把 ACP 的 configOptions 转成手机端的模型 / 推理强度 / 模式选项。
    fn apply_config(&mut self, options: &Value, cx: &mut Cx) -> HashMap<String, String> {
        let mut current = HashMap::new();
        for option in options.as_array().into_iter().flatten() {
            let Some(id) = str_at(option, "/id") else {
                continue;
            };
            let key = match (id, str_at(option, "/category")) {
                ("model", _) | (_, Some("model")) => "models",
                ("effort", _) | (_, Some("thought_level")) => "efforts",
                ("mode", _) | (_, Some("mode")) => "modes",
                _ => continue,
            };
            let values: Vec<Value> = option
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|entry| json!({ "id": entry.get("value"), "label": entry.get("name") }))
                .collect();
            super::set_option(cx.thread, key, json!(values));
            if let Some(value) = str_at(option, "/currentValue") {
                current.insert(id.to_string(), value.to_string());
                match key {
                    "models" => cx.thread.data.model = Some(value.to_string()),
                    "efforts" => cx.thread.data.effort = Some(value.to_string()),
                    _ => cx.thread.data.mode = Some(value.to_string()),
                }
            }
        }
        cx.thread.bump();
        current
    }

    fn write_prompt(&mut self, cx: &mut Cx, prompt: Prompt) {
        let Some(session) = self.session.clone() else {
            self.queue.push(prompt);
            return;
        };
        let mut blocks = Vec::new();
        if !prompt.text.is_empty() || prompt.images.is_empty() {
            blocks.push(json!({ "type": "text", "text": prompt.text }));
        }
        for image in &prompt.images {
            blocks.push(json!({ "type": "image", "mimeType": image.mime, "data": image.data }));
        }
        self.prompting += 1;
        self.turn += 1;
        self.segment = None;
        self.request(
            cx,
            "session/prompt",
            json!({ "sessionId": session, "prompt": blocks }),
            Pending::Prompt,
        );
    }

    fn on_response(&mut self, id: u64, message: &Value, cx: &mut Cx) {
        let Some(pending) = self.pending.remove(&id) else {
            return;
        };
        let error = message
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string);
        let result = message.get("result").cloned().unwrap_or_default();
        match pending {
            Pending::Initialize => {
                if let Some(error) = error {
                    cx.thread.fail(format!("OpenCode 初始化失败：{error}"));
                    return;
                }
                self.can_resume = result
                    .pointer("/agentCapabilities/sessionCapabilities/resume")
                    .is_some();
                self.can_load = result
                    .pointer("/agentCapabilities/loadSession")
                    .and_then(Value::as_bool)
                    == Some(true);
                self.open_session(cx);
            }
            Pending::Session { resumed } => {
                self.replaying = false;
                if let Some(error) = error {
                    if resumed {
                        cx.thread.notice(
                            "warn",
                            format!("无法恢复原 OpenCode 会话，已新建会话：{error}"),
                        );
                        self.session = None;
                        self.open_session(cx);
                    } else {
                        cx.thread.fail(format!("OpenCode 新建会话失败：{error}"));
                    }
                    return;
                }
                if let Some(session) = str_at(&result, "/sessionId") {
                    self.session = Some(session.to_string());
                }
                cx.thread.data.session = self.session.clone();
                let current =
                    self.apply_config(result.get("configOptions").unwrap_or(&Value::Null), cx);
                // 恢复用户在手机上选择过的模型、推理强度和模式。
                for (id, wanted) in [
                    ("model", self.model.clone()),
                    ("effort", self.effort.clone()),
                    ("mode", self.mode.clone()),
                ] {
                    if let Some(wanted) = wanted {
                        if current.get(id).is_some_and(|value| *value != wanted) {
                            self.set_config(cx, id, &wanted);
                        }
                    }
                }
                self.ready = true;
                let queue = std::mem::take(&mut self.queue);
                if queue.is_empty() {
                    cx.thread.set_status(Status::Idle);
                }
                for prompt in queue {
                    self.write_prompt(cx, prompt);
                }
            }
            Pending::Prompt => {
                self.prompting = self.prompting.saturating_sub(1);
                self.segment = None;
                if let Some(error) = error {
                    cx.thread.notice("error", error);
                } else {
                    match str_at(&result, "/stopReason") {
                        Some("cancelled") => cx.thread.notice("info", "已停止"),
                        Some("max_tokens") => cx.thread.notice("warn", "回复达到长度上限"),
                        Some("refusal") => cx.thread.notice("warn", "模型拒绝了该请求"),
                        _ => {}
                    }
                    if let Some(usage) = result.get("usage").filter(|usage| usage.is_object()) {
                        merge_usage(cx, usage);
                    }
                }
                if self.prompting == 0 {
                    cx.thread.settle("expired");
                    cx.thread.set_status(Status::Idle);
                }
                cx.thread.dirty = true;
            }
            Pending::Config => {
                if let Some(error) = error {
                    cx.thread
                        .notice("warn", format!("OpenCode 未接受该设置：{error}"));
                } else if let Some(options) = result.get("configOptions") {
                    self.apply_config(options, cx);
                }
            }
        }
    }

    fn text_segment(&mut self, kind: &'static str, text: &str, cx: &mut Cx) {
        if text.is_empty() {
            return;
        }
        let id = match &self.segment {
            Some((current, id)) if *current == kind => id.clone(),
            _ => {
                let id = format!("oc-{}-{}", kind, uuid::Uuid::new_v4().simple());
                self.segment = Some((kind, id.clone()));
                id
            }
        };
        cx.thread.append_text(&id, kind, text);
    }

    fn on_tool(&mut self, update: &Value, cx: &mut Cx) {
        let Some(tool) = str_at(update, "/toolCallId") else {
            return;
        };
        self.segment = None;
        let id = format!("oc-tool-{tool}");
        let mut files = Vec::new();
        let mut output = String::new();
        for content in update
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match str_at(content, "/type") {
                Some("diff") => {
                    let old = str_at(content, "/oldText").unwrap_or_default();
                    let new = str_at(content, "/newText").unwrap_or_default();
                    files.push(json!({
                        "path": content.get("path"),
                        "change": if content.get("oldText").is_none_or(Value::is_null) { "add" } else { "update" },
                        "diff": line_diff(old, new),
                    }));
                }
                Some("content") => {
                    if let Some(text) = str_at(content, "/content/text") {
                        output.push_str(text);
                    }
                }
                _ => {}
            }
        }
        if output.is_empty() {
            if let Some(raw) = update.get("rawOutput") {
                output = raw
                    .get("output")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| super::content_text(raw));
            }
        }
        super::tool(cx.thread, &id, |entry| {
            if let Some(kind) = str_at(update, "/kind") {
                entry.insert("category".into(), json!(category(kind)));
            } else if !entry.contains_key("category") {
                entry.insert("category".into(), json!("other"));
            }
            let command = str_at(update, "/rawInput/command");
            if let Some(title) = command
                .or(str_at(update, "/title"))
                .filter(|title| !title.is_empty())
            {
                entry.insert("title".into(), json!(title));
            }
            if command.is_some() {
                if let Some(title) = str_at(update, "/title") {
                    entry.insert("detail".into(), json!(title));
                }
            } else if let Some(path) = update.pointer("/locations/0/path") {
                entry.insert("detail".into(), path.clone());
            }
            if let Some(status) = str_at(update, "/status") {
                entry.insert(
                    "status".into(),
                    json!(match status {
                        "completed" => "done",
                        "failed" => "failed",
                        _ => "running",
                    }),
                );
            } else if !entry.contains_key("status") {
                entry.insert("status".into(), json!("running"));
            }
            if !files.is_empty() {
                entry.insert("files".into(), json!(files));
            }
            if !output.trim().is_empty() {
                entry.insert("output".into(), json!(clip_tail(&output, MAX_TOOL_OUTPUT)));
            }
        });
    }

    fn on_update(&mut self, update: &Value, cx: &mut Cx) {
        if self.replaying {
            return;
        }
        match str_at(update, "/sessionUpdate").unwrap_or_default() {
            "agent_message_chunk" => {
                if let Some(text) = str_at(update, "/content/text") {
                    self.text_segment("assistant", text, cx);
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = str_at(update, "/content/text") {
                    self.text_segment("reasoning", text, cx);
                }
            }
            "tool_call" | "tool_call_update" => self.on_tool(update, cx),
            "plan" => {
                let steps: Vec<Value> = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|entry| {
                        json!({
                            "text": entry.get("content"),
                            "status": match str_at(entry, "/status") {
                                Some("completed") => "done",
                                Some("in_progress") => "running",
                                _ => "pending",
                            },
                        })
                    })
                    .collect();
                cx.thread
                    .upsert(&format!("oc-plan-{}", self.turn), "plan", |entry| {
                        entry.insert("steps".into(), json!(steps));
                    });
            }
            "available_commands_update" => {
                let commands: Vec<Value> = update
                    .get("availableCommands")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|command| json!({ "name": command.get("name"), "description": command.get("description") }))
                    .collect();
                super::set_option(cx.thread, "commands", json!(commands));
            }
            "current_mode_update" => {
                if let Some(mode) = str_at(update, "/currentModeId") {
                    cx.thread.data.mode = Some(mode.to_string());
                    cx.thread.bump();
                }
            }
            "config_option_update" => {
                if let Some(options) = update.get("configOptions") {
                    self.apply_config(options, cx);
                }
            }
            "usage_update" => merge_usage(cx, update),
            "session_info_update" => {
                if let Some(title) = str_at(update, "/title").filter(|title| !title.is_empty()) {
                    if !cx.thread.data.title_manual {
                        cx.thread.data.title = title.to_string();
                        cx.thread.bump();
                    }
                }
            }
            _ => {}
        }
    }

    fn on_permission(&mut self, id: &Value, params: &Value, cx: &mut Cx) {
        let options: Vec<Value> = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pick = |kinds: &[&str]| {
            kinds.iter().find_map(|kind| {
                options
                    .iter()
                    .find(|option| str_at(option, "/kind") == Some(kind))
                    .and_then(|option| str_at(option, "/optionId"))
                    .map(str::to_string)
            })
        };
        let tool = params.get("toolCall").cloned().unwrap_or_default();
        if tool.is_object() {
            self.on_tool(&tool, cx);
        }
        let tool_item = str_at(&tool, "/toolCallId").map(|tool| format!("oc-tool-{tool}"));
        let category = str_at(&tool, "/kind").map(category).or_else(|| {
            tool_item
                .as_deref()
                .and_then(|item| cx.thread.item(item))
                .and_then(|entry| entry.get("tool")?.get("category")?.as_str())
                .map(|category| match category {
                    "edit" => "edit",
                    "command" => "command",
                    _ => "other",
                })
        });
        let automatic = match self.safety.as_str() {
            "full" => pick(&["allow_always", "allow_once"]),
            "edits" if category == Some("edit") => pick(&["allow_once", "allow_always"]),
            _ => None,
        };
        if let Some(option) = automatic {
            cx.send(json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "selected", "optionId": option } } }));
            return;
        }
        let entry = tool_item
            .as_deref()
            .and_then(|item| cx.thread.item(item))
            .cloned();
        let title = entry
            .as_ref()
            .and_then(|entry| {
                entry
                    .get("tool")?
                    .get("title")?
                    .as_str()
                    .map(str::to_string)
            })
            .or_else(|| str_at(&tool, "/title").map(str::to_string))
            .unwrap_or_else(|| "OpenCode 请求权限".into());
        let detail = entry
            .as_ref()
            .and_then(|entry| {
                entry
                    .get("tool")?
                    .get("detail")?
                    .as_str()
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let buttons: Vec<Value> = options
            .iter()
            .map(|option| {
                let kind = str_at(option, "/kind").unwrap_or_default();
                json!({
                    "id": option.get("optionId"),
                    "label": match kind {
                        "allow_once" => "允许".to_string(),
                        "allow_always" => "总是允许".to_string(),
                        "reject_once" => "拒绝".to_string(),
                        "reject_always" => "总是拒绝".to_string(),
                        _ => str_at(option, "/name").unwrap_or("选择").to_string(),
                    },
                    "tone": match kind {
                        "allow_once" => "primary",
                        k if k.starts_with("reject") => "danger",
                        _ => "neutral",
                    },
                })
            })
            .collect();
        let item = format!("oc-approval-{}", super::rpc_key(id));
        let kind = match category {
            Some("edit") => "edit",
            Some("command") => "command",
            _ => "tool",
        };
        approval_item(
            cx.thread,
            &item,
            kind,
            &title,
            &detail,
            json!(buttons),
            None,
        );
        if let Some(files) = entry.and_then(|entry| entry.get("tool")?.get("files").cloned()) {
            cx.thread.upsert(&item, "approval", |approval| {
                approval.insert("files".into(), files);
            });
        }
        self.requests.insert(item, (id.clone(), options));
    }

    fn cancel_requests(&mut self, cx: &mut Cx) {
        for (item, (id, _)) in std::mem::take(&mut self.requests) {
            cx.send(json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "cancelled" } } }));
            approval_resolved(cx.thread, &item, "cancelled", &Value::Null);
        }
    }
}

fn category(kind: &str) -> &'static str {
    match kind {
        "read" => "read",
        "edit" | "delete" | "move" => "edit",
        "search" => "search",
        "execute" => "command",
        "fetch" => "web",
        _ => "other",
    }
}

fn line_diff(old: &str, new: &str) -> String {
    let mut diff = String::new();
    for line in old.lines() {
        diff.push('-');
        diff.push_str(line);
        diff.push('\n');
    }
    for line in new.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    clip_tail(&diff, MAX_TOOL_OUTPUT)
}

fn merge_usage(cx: &mut Cx, usage: &Value) {
    if !cx.thread.data.usage.is_object() {
        cx.thread.data.usage = json!({});
    }
    let target = &mut cx.thread.data.usage;
    for (from, to) in [
        ("used", "contextUsed"),
        ("size", "contextWindow"),
        ("inputTokens", "inputTokens"),
        ("outputTokens", "outputTokens"),
        ("totalTokens", "totalTokens"),
    ] {
        if let Some(value) = usage.get(from).filter(|value| value.is_number()) {
            target[to] = value.clone();
        }
    }
    if let Some(cost) = usage.get("cost").filter(|cost| cost.is_object()) {
        target["cost"] = json!({ "amount": cost.get("amount"), "currency": cost.get("currency") });
    }
    cx.thread.bump();
}

impl Adapter for Opencode {
    fn launch(&self) -> Launch {
        Launch {
            program: "opencode".into(),
            args: vec!["acp".into()],
            env: vec![("OPENCODE_CONFIG_CONTENT".into(), PERMISSION_CONFIG.into())],
        }
    }

    fn start(&mut self, cx: &mut Cx) {
        self.request(
            cx,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "qingcode", "title": "QingCode", "version": env!("CARGO_PKG_VERSION") },
            }),
            Pending::Initialize,
        );
    }

    fn on_line(&mut self, message: Value, cx: &mut Cx) {
        let method = message.get("method").and_then(Value::as_str);
        match (message.get("id"), method) {
            (Some(id), Some("session/request_permission")) => {
                let params = message.get("params").cloned().unwrap_or_default();
                self.on_permission(id, &params, cx);
            }
            (Some(id), Some(_)) => cx.send(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": "QingCode 手机端不支持该请求" },
            })),
            (Some(id), None) => {
                if let Some(id) = id.as_u64() {
                    self.on_response(id, &message, cx);
                }
            }
            (None, Some("session/update")) => {
                if let Some(update) = message.pointer("/params/update") {
                    self.on_update(&update.clone(), cx);
                }
            }
            _ => {}
        }
    }

    fn send(&mut self, prompt: Prompt, cx: &mut Cx) -> Result<(), String> {
        if self.ready {
            self.write_prompt(cx, prompt);
        } else {
            self.queue.push(prompt);
        }
        Ok(())
    }

    fn interrupt(&mut self, cx: &mut Cx) -> Result<(), String> {
        let session = self
            .session
            .clone()
            .filter(|_| self.prompting > 0)
            .ok_or("当前没有进行中的任务。")?;
        self.cancel_requests(cx);
        cx.send(json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } }));
        Ok(())
    }

    fn respond(
        &mut self,
        approval: &str,
        choice: &str,
        answers: &Value,
        cx: &mut Cx,
    ) -> Result<(), String> {
        let (id, options) = self
            .requests
            .remove(approval)
            .ok_or("该请求已处理或已失效。")?;
        let valid = options
            .iter()
            .any(|option| str_at(option, "/optionId") == Some(choice));
        let outcome = if valid {
            json!({ "outcome": "selected", "optionId": choice })
        } else {
            json!({ "outcome": "cancelled" })
        };
        cx.send(json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": outcome } }));
        approval_resolved(cx.thread, approval, choice, answers);
        Ok(())
    }

    fn configure(&mut self, key: &str, value: &str, cx: &mut Cx) -> Result<bool, String> {
        match key {
            "safety" => self.safety = value.to_string(),
            "model" | "effort" | "mode" => {
                let value = Some(value.to_string()).filter(|value| !value.is_empty());
                match key {
                    "model" => self.model = value.clone(),
                    "effort" => self.effort = value.clone(),
                    _ => self.mode = value.clone(),
                }
                if let (true, Some(value)) = (self.ready, value) {
                    self.set_config(cx, key, &value);
                }
            }
            _ => return Err("OpenCode 不支持该设置。".into()),
        }
        Ok(false)
    }

    fn pending_requests(&self) -> usize {
        self.requests.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::thread::tests_support::sample;
    use crate::agent::Provider;

    fn feed(
        agent: &mut Opencode,
        thread: &mut crate::agent::thread::Thread,
        line: Value,
    ) -> Vec<Value> {
        let mut cx = Cx::new(thread);
        agent.on_line(line, &mut cx);
        cx.out
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn ready(safety: &str, session: Option<&str>) -> (Opencode, crate::agent::thread::Thread) {
        let mut thread = sample(Provider::Opencode);
        let mut agent = Opencode::new(
            "D:\\demo".into(),
            safety.into(),
            Some("m2".into()),
            None,
            None,
            session.map(str::to_string),
        );
        {
            let mut cx = Cx::new(&mut thread);
            agent.start(&mut cx);
        }
        let out = feed(
            &mut agent,
            &mut thread,
            json!({ "jsonrpc": "2.0", "id": 1, "result": {
            "agentCapabilities": { "loadSession": true, "sessionCapabilities": { "resume": {} } },
        } }),
        );
        let method = out[0]["method"].as_str().unwrap().to_string();
        assert_eq!(
            method,
            if session.is_some() {
                "session/resume"
            } else {
                "session/new"
            }
        );
        let out = feed(
            &mut agent,
            &mut thread,
            json!({ "jsonrpc": "2.0", "id": 2, "result": {
            "sessionId": "ses1",
            "configOptions": [
                { "id": "model", "category": "model", "currentValue": "m1", "options": [{ "value": "m1", "name": "M1" }, { "value": "m2", "name": "M2" }] },
                { "id": "mode", "category": "mode", "currentValue": "build", "options": [{ "value": "build", "name": "Build" }, { "value": "plan", "name": "Plan" }] },
            ],
        } }),
        );
        // 恢复手机上选过的模型。
        assert_eq!(out[0]["method"], "session/set_config_option");
        assert_eq!(out[0]["params"]["value"], "m2");
        assert_eq!(thread.status, Status::Idle);
        assert_eq!(thread.options["modes"][1]["id"], "plan");
        (agent, thread)
    }

    #[test]
    fn launch_forces_permission_prompts_through_the_host() {
        let agent = Opencode::new("/w".into(), "full".into(), None, None, None, None);
        let launch = agent.launch();
        assert_eq!(launch.args, ["acp"]);
        let config: Value = serde_json::from_str(&launch.env[0].1).unwrap();
        assert_eq!(config["permission"]["*"], "ask");
        assert_eq!(config["permission"]["read"], "allow");
    }

    #[test]
    fn chunks_tools_and_prompt_completion_become_chat_entries() {
        let (mut agent, mut thread) = ready("ask", None);
        {
            let mut cx = Cx::new(&mut thread);
            agent
                .send(
                    Prompt {
                        text: "hi".into(),
                        images: vec![],
                    },
                    &mut cx,
                )
                .unwrap();
            let prompt: Value = serde_json::from_str(cx.out.last().unwrap()).unwrap();
            assert_eq!(prompt["method"], "session/prompt");
            assert_eq!(prompt["params"]["prompt"][0]["text"], "hi");
        }
        let update = |value: Value| json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "ses1", "update": value } });
        feed(
            &mut agent,
            &mut thread,
            update(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "好" } }),
            ),
        );
        feed(
            &mut agent,
            &mut thread,
            update(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "的" } }),
            ),
        );
        let assistants: Vec<_> = thread
            .data
            .items
            .iter()
            .filter(|item| item["kind"] == "assistant")
            .collect();
        assert_eq!(assistants.len(), 1);
        assert_eq!(assistants[0]["text"], "好的");
        feed(
            &mut agent,
            &mut thread,
            update(
                json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "bash", "kind": "execute", "status": "pending", "rawInput": { "command": "ls" } }),
            ),
        );
        feed(
            &mut agent,
            &mut thread,
            update(
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{ "type": "content", "content": { "type": "text", "text": "a.txt" } }] }),
            ),
        );
        let tool = thread.item("oc-tool-t1").unwrap()["tool"].clone();
        assert_eq!(tool["category"], "command");
        assert_eq!(tool["title"], "ls");
        assert_eq!(tool["status"], "done");
        assert_eq!(tool["output"], "a.txt");
        feed(
            &mut agent,
            &mut thread,
            update(
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "完成" } }),
            ),
        );
        assert_eq!(
            thread
                .data
                .items
                .iter()
                .filter(|item| item["kind"] == "assistant")
                .count(),
            2
        );
        feed(
            &mut agent,
            &mut thread,
            update(
                json!({ "sessionUpdate": "usage_update", "used": 1200, "size": 200000, "cost": { "amount": 0.01, "currency": "USD" } }),
            ),
        );
        assert_eq!(thread.data.usage["contextWindow"], 200000);
        let prompt_id = 4;
        feed(
            &mut agent,
            &mut thread,
            json!({ "jsonrpc": "2.0", "id": prompt_id, "result": { "stopReason": "end_turn" } }),
        );
        assert_eq!(thread.status, Status::Idle);
    }

    #[test]
    fn permissions_follow_the_current_safety_option() {
        let (mut agent, mut thread) = ready("edits", None);
        let options = json!([
            { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
            { "optionId": "always", "name": "Always", "kind": "allow_always" },
            { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
        ]);
        let request = |id: u64, kind: &str| {
            json!({ "jsonrpc": "2.0", "id": id, "method": "session/request_permission", "params": {
            "sessionId": "ses1", "toolCall": { "toolCallId": format!("t{id}"), "title": "x", "kind": kind }, "options": options,
        } })
        };
        let out = feed(&mut agent, &mut thread, request(50, "edit"));
        assert_eq!(out[0]["result"]["outcome"]["optionId"], "once");
        let out = feed(&mut agent, &mut thread, request(51, "execute"));
        assert!(out.is_empty());
        assert_eq!(thread.pending_approvals(), 1);
        let approval = thread.item("oc-approval-51").unwrap()["approval"].clone();
        assert_eq!(approval["options"][0]["label"], "允许");
        let mut cx = Cx::new(&mut thread);
        agent
            .respond("oc-approval-51", "reject", &Value::Null, &mut cx)
            .unwrap();
        let reply: Value = serde_json::from_str(&cx.out[0]).unwrap();
        assert_eq!(reply["result"]["outcome"]["optionId"], "reject");
        agent.configure("safety", "full", &mut cx).unwrap();
        drop(cx);
        let out = feed(&mut agent, &mut thread, request(52, "execute"));
        assert_eq!(out[0]["result"]["outcome"]["optionId"], "always");
    }

    #[test]
    fn cancel_answers_pending_permissions() {
        let (mut agent, mut thread) = ready("ask", Some("old"));
        {
            let mut cx = Cx::new(&mut thread);
            agent
                .send(
                    Prompt {
                        text: "go".into(),
                        images: vec![],
                    },
                    &mut cx,
                )
                .unwrap();
        }
        feed(
            &mut agent,
            &mut thread,
            json!({ "jsonrpc": "2.0", "id": 9, "method": "session/request_permission", "params": {
            "sessionId": "ses1", "toolCall": { "toolCallId": "t9", "kind": "execute" }, "options": [{ "optionId": "o", "kind": "allow_once" }],
        } }),
        );
        let mut cx = Cx::new(&mut thread);
        agent.interrupt(&mut cx).unwrap();
        let replies: Vec<Value> = cx
            .out
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies[0]["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(replies[1]["method"], "session/cancel");
    }

    #[test]
    fn client_side_requests_are_rejected() {
        let (mut agent, mut thread) = ready("ask", None);
        let out = feed(
            &mut agent,
            &mut thread,
            json!({ "jsonrpc": "2.0", "id": 7, "method": "fs/read_text_file", "params": {} }),
        );
        assert_eq!(out[0]["error"]["code"], -32601);
    }
}
