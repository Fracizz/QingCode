//! Codex：`codex app-server` 的 JSON-RPC（每行一条 JSON，无 `jsonrpc` 字段）。
//!
//! 每轮 `turn/start` 都带上审批策略与沙箱，切换安全选项后下一轮立即生效。
use std::collections::HashMap;

use serde_json::{json, Value};

use super::process::Launch;
use super::thread::{Status, MAX_TOOL_OUTPUT};
use super::{approval_item, approval_resolved, str_at, Adapter, Cx, Prompt};

pub const SAFETY: &[(&str, &str, &str)] = &[
    (
        "read-only",
        "只读",
        "可读取文件；编辑文件和运行命令前在手机上确认",
    ),
    (
        "auto",
        "自动",
        "在项目内自动编辑和运行命令；越过沙箱时在手机上确认",
    ),
    (
        "full",
        "完全访问",
        "不受沙箱限制，不再询问，直接编辑文件和运行命令",
    ),
];
pub const DEFAULT_SAFETY: &str = "auto";

/// 安全选项 → (审批策略, 新建会话的沙箱模式, 每轮沙箱策略)。
pub fn policy(safety: &str) -> (&'static str, &'static str, Value) {
    match safety {
        "read-only" => ("on-request", "read-only", json!({ "type": "readOnly" })),
        "full" => (
            "never",
            "danger-full-access",
            json!({ "type": "dangerFullAccess" }),
        ),
        _ => (
            "on-request",
            "workspace-write",
            json!({ "type": "workspaceWrite" }),
        ),
    }
}

enum Pending {
    Initialize,
    Thread { resumed: bool },
    Turn,
    Models,
    RateLimits,
    Other,
}

enum Request {
    Command,
    FileChange,
    Permissions(Value),
    Question,
}

pub struct Codex {
    cwd: String,
    safety: String,
    model: Option<String>,
    effort: Option<String>,
    session: Option<String>,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    ready: bool,
    queue: Vec<Prompt>,
    turn: Option<String>,
    /// 审批条目 id → (JSON-RPC 请求 id, 请求类型)。
    requests: HashMap<String, (Value, Request)>,
}

impl Codex {
    pub fn new(
        cwd: String,
        safety: String,
        model: Option<String>,
        effort: Option<String>,
        session: Option<String>,
    ) -> Self {
        Self {
            cwd,
            safety,
            model,
            effort,
            session,
            next_id: 0,
            pending: HashMap::new(),
            ready: false,
            queue: Vec::new(),
            turn: None,
            requests: HashMap::new(),
        }
    }

    fn request(&mut self, cx: &mut Cx, method: &str, params: Value, pending: Pending) {
        self.next_id += 1;
        self.pending.insert(self.next_id, pending);
        cx.send(json!({ "id": self.next_id, "method": method, "params": params }));
    }

    fn open_thread(&mut self, cx: &mut Cx, resume: bool) {
        let (approval, sandbox, _) = policy(&self.safety);
        let mut params = json!({
            "cwd": self.cwd,
            "approvalPolicy": approval,
            "sandbox": sandbox,
            "model": self.model,
        });
        match self.session.clone().filter(|_| resume) {
            Some(session) => {
                params["threadId"] = json!(session);
                params["excludeTurns"] = json!(true);
                self.request(
                    cx,
                    "thread/resume",
                    params,
                    Pending::Thread { resumed: true },
                );
            }
            None => self.request(
                cx,
                "thread/start",
                params,
                Pending::Thread { resumed: false },
            ),
        }
    }

    fn start_turn(&mut self, cx: &mut Cx, prompt: Prompt) {
        let Some(session) = self.session.clone() else {
            self.queue.push(prompt);
            return;
        };
        let mut input = Vec::new();
        if !prompt.text.is_empty() {
            input.push(json!({ "type": "text", "text": prompt.text, "text_elements": [] }));
        }
        for image in &prompt.images {
            input.push(json!({ "type": "image", "url": format!("data:{};base64,{}", image.mime, image.data) }));
        }
        let (approval, _, sandbox) = policy(&self.safety);
        let params = json!({
            "threadId": session,
            "input": input,
            "approvalPolicy": approval,
            "sandboxPolicy": sandbox,
            "model": self.model,
            "effort": self.effort,
        });
        self.request(cx, "turn/start", params, Pending::Turn);
    }

    fn flush(&mut self, cx: &mut Cx) {
        let queue = std::mem::take(&mut self.queue);
        for prompt in queue {
            self.start_turn(cx, prompt);
        }
    }

    fn reply(cx: &mut Cx, id: &Value, result: Value) {
        cx.send(json!({ "id": id, "result": result }));
    }

    fn reply_error(cx: &mut Cx, id: &Value, message: &str) {
        cx.send(json!({ "id": id, "error": { "code": -32601, "message": message } }));
    }

    fn on_response(&mut self, id: u64, message: &Value, cx: &mut Cx) {
        let Some(pending) = self.pending.remove(&id) else {
            return;
        };
        let error = message
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string);
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        match pending {
            Pending::Initialize => {
                if let Some(error) = error {
                    cx.thread.fail(format!("Codex 初始化失败：{error}"));
                    return;
                }
                cx.send(json!({ "method": "initialized" }));
                self.open_thread(cx, true);
                self.request(cx, "model/list", json!({ "limit": 50 }), Pending::Models);
                self.request(
                    cx,
                    "account/rateLimits/read",
                    Value::Null,
                    Pending::RateLimits,
                );
            }
            Pending::Thread { resumed } => {
                if let Some(error) = error {
                    if resumed {
                        cx.thread.notice(
                            "warn",
                            format!("无法恢复原 Codex 会话，已新建会话：{error}"),
                        );
                        self.session = None;
                        self.open_thread(cx, false);
                    } else {
                        cx.thread.fail(format!("Codex 新建会话失败：{error}"));
                    }
                    return;
                }
                if let Some(session) = str_at(&result, "/thread/id") {
                    self.session = Some(session.to_string());
                    cx.thread.data.session = Some(session.to_string());
                }
                if let Some(model) = str_at(&result, "/model") {
                    if self.model.is_none() {
                        cx.thread.data.model = Some(model.to_string());
                    }
                }
                self.ready = true;
                if self.queue.is_empty() {
                    cx.thread.set_status(Status::Idle);
                } else {
                    self.flush(cx);
                }
            }
            Pending::Turn => {
                if let Some(error) = error {
                    cx.thread
                        .notice("error", format!("Codex 未能开始本轮：{error}"));
                    cx.thread.set_status(Status::Idle);
                } else if let Some(turn) = str_at(&result, "/turn/id") {
                    self.turn = Some(turn.to_string());
                }
            }
            Pending::Models => {
                let models: Vec<Value> = result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|model| model.get("hidden").and_then(Value::as_bool) != Some(true))
                    .map(|model| {
                        json!({
                            "id": model.get("model").or(model.get("id")),
                            "label": model.get("displayName"),
                            "description": model.get("description"),
                            "default": model.get("isDefault"),
                            "efforts": model
                                .get("supportedReasoningEfforts")
                                .and_then(Value::as_array)
                                .map(|efforts| efforts
                                    .iter()
                                    .filter_map(|effort| effort.get("reasoningEffort").cloned())
                                    .collect::<Vec<_>>()),
                        })
                    })
                    .collect();
                super::set_option(cx.thread, "models", json!(models));
            }
            Pending::RateLimits => {
                cx.quota = Some(match error {
                    Some(error) if error.contains("authentication") => {
                        json!({ "error": "Codex 未登录，请先在电脑上运行 codex 登录。" })
                    }
                    Some(error) => json!({ "error": error }),
                    None => quota(result.get("rateLimits").unwrap_or(&Value::Null)),
                });
            }
            Pending::Other => {
                if let Some(error) = error {
                    cx.thread.notice("warn", error);
                }
            }
        }
    }

    fn apply_item(&mut self, item: &Value, done: bool, cx: &mut Cx) {
        let Some(raw) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        let id = format!("cx-{raw}");
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .map(tool_status)
            .unwrap_or(if done { "done" } else { "running" });
        match item.get("type").and_then(Value::as_str).unwrap_or_default() {
            "agentMessage" | "plan" => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                let plan = item.get("type").and_then(Value::as_str) == Some("plan");
                if !done && text.is_empty() && !cx.thread.has_item(&id) {
                    return;
                }
                cx.thread.upsert(&id, "assistant", |entry| {
                    if done || !text.is_empty() {
                        entry.insert("text".into(), json!(text));
                    }
                    if plan {
                        entry.insert("proposal".into(), json!(true));
                    }
                    if done {
                        entry.remove("streaming");
                    } else {
                        entry.insert("streaming".into(), json!(true));
                    }
                });
            }
            "reasoning" => {
                let parts = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .filter(|parts| !parts.is_empty())
                    .or(item.get("content").and_then(Value::as_array));
                let text = parts
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                    .unwrap_or_default();
                if text.is_empty() && !cx.thread.has_item(&id) {
                    return;
                }
                cx.thread.upsert(&id, "reasoning", |entry| {
                    if !text.is_empty() {
                        entry.insert("text".into(), json!(text));
                    }
                    if done {
                        entry.remove("streaming");
                    } else {
                        entry.insert("streaming".into(), json!(true));
                    }
                });
            }
            "commandExecution" => {
                let output = item.get("aggregatedOutput").and_then(Value::as_str);
                super::tool(cx.thread, &id, |tool| {
                    tool.insert("category".into(), json!("command"));
                    tool.insert(
                        "title".into(),
                        item.get("command").cloned().unwrap_or_default(),
                    );
                    tool.insert("status".into(), json!(status));
                    if let Some(code) = item.get("exitCode").filter(|code| !code.is_null()) {
                        tool.insert("exitCode".into(), code.clone());
                    }
                    if let Some(output) = output {
                        tool.insert(
                            "output".into(),
                            json!(super::thread::clip_tail(output, MAX_TOOL_OUTPUT)),
                        );
                    }
                });
            }
            "fileChange" => {
                let files: Vec<Value> = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|change| {
                        json!({
                            "path": change.get("path"),
                            "change": change.pointer("/kind/type"),
                            "diff": change
                                .get("diff")
                                .and_then(Value::as_str)
                                .map(|diff| super::thread::clip_tail(diff, MAX_TOOL_OUTPUT)),
                        })
                    })
                    .collect();
                let title = match files.as_slice() {
                    [file] => file["path"].as_str().unwrap_or("文件").to_string(),
                    files => format!("{} 个文件", files.len()),
                };
                super::tool(cx.thread, &id, |tool| {
                    tool.insert("category".into(), json!("edit"));
                    tool.insert("title".into(), json!(title));
                    tool.insert("status".into(), json!(status));
                    tool.insert("files".into(), json!(files));
                });
            }
            "mcpToolCall" | "dynamicToolCall" => {
                let name = match (
                    item.get("server").and_then(Value::as_str),
                    str_at(item, "/tool"),
                ) {
                    (Some(server), Some(tool)) => format!("{server} · {tool}"),
                    (None, Some(tool)) => tool.to_string(),
                    _ => "工具".into(),
                };
                let output = item
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| item.get("result").map(super::content_text));
                super::tool(cx.thread, &id, |tool| {
                    tool.insert("category".into(), json!("mcp"));
                    tool.insert("title".into(), json!(name));
                    tool.insert(
                        "detail".into(),
                        json!(super::compact_json(item.get("arguments"))),
                    );
                    tool.insert("status".into(), json!(status));
                    if let Some(output) = output.filter(|output| !output.is_empty()) {
                        tool.insert(
                            "output".into(),
                            json!(super::thread::clip_tail(&output, MAX_TOOL_OUTPUT)),
                        );
                    }
                });
            }
            "webSearch" => super::tool(cx.thread, &id, |tool| {
                tool.insert("category".into(), json!("web"));
                tool.insert(
                    "title".into(),
                    item.get("query").cloned().unwrap_or_default(),
                );
                tool.insert(
                    "status".into(),
                    json!(if done { "done" } else { "running" }),
                );
            }),
            "imageView" => super::tool(cx.thread, &id, |tool| {
                tool.insert("category".into(), json!("read"));
                tool.insert(
                    "title".into(),
                    item.get("path").cloned().unwrap_or_default(),
                );
                tool.insert("status".into(), json!("done"));
            }),
            "collabAgentToolCall" | "subAgentActivity" => super::tool(cx.thread, &id, |tool| {
                tool.insert("category".into(), json!("agent"));
                tool.insert(
                    "title".into(),
                    item.get("prompt")
                        .or(item.get("agentPath"))
                        .cloned()
                        .unwrap_or(json!("子代理")),
                );
                tool.insert(
                    "status".into(),
                    json!(if done { "done" } else { "running" }),
                );
            }),
            "contextCompaction" if done => cx.thread.notice("info", "上下文已压缩"),
            "enteredReviewMode" if done => cx.thread.notice("info", "进入代码审查"),
            "exitedReviewMode" if done => cx.thread.notice("info", "代码审查结束"),
            _ => {}
        }
    }

    fn on_notification(&mut self, method: &str, params: &Value, cx: &mut Cx) {
        match method {
            "turn/started" => {
                self.turn = str_at(params, "/turn/id").map(str::to_string);
                cx.thread.set_status(Status::Running);
            }
            "turn/completed" => {
                self.turn = None;
                match str_at(params, "/turn/status") {
                    Some("failed") => {
                        let message =
                            str_at(params, "/turn/error/message").unwrap_or("本轮执行失败");
                        cx.thread.notice("error", message.to_string());
                    }
                    Some("interrupted") => cx.thread.notice("info", "已停止"),
                    _ => {}
                }
                cx.thread.settle("expired");
                cx.thread.set_status(Status::Idle);
                cx.thread.dirty = true;
                self.request(
                    cx,
                    "account/rateLimits/read",
                    Value::Null,
                    Pending::RateLimits,
                );
            }
            "item/started" | "item/completed" => {
                if let Some(item) = params.get("item") {
                    self.apply_item(item, method == "item/completed", cx);
                }
            }
            "item/agentMessage/delta" | "item/plan/delta" => {
                if let (Some(item), Some(delta)) =
                    (str_at(params, "/itemId"), str_at(params, "/delta"))
                {
                    let id = format!("cx-{item}");
                    cx.thread.append_text(&id, "assistant", delta);
                    cx.thread.upsert(&id, "assistant", |entry| {
                        entry.insert("streaming".into(), json!(true));
                    });
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                if let (Some(item), Some(delta)) =
                    (str_at(params, "/itemId"), str_at(params, "/delta"))
                {
                    cx.thread
                        .append_text(&format!("cx-{item}"), "reasoning", delta);
                }
            }
            "item/reasoning/summaryPartAdded" => {
                if let Some(item) = str_at(params, "/itemId") {
                    let id = format!("cx-{item}");
                    if cx.thread.has_item(&id) {
                        cx.thread.append_text(&id, "reasoning", "\n\n");
                    }
                }
            }
            "item/commandExecution/outputDelta" => {
                if let (Some(item), Some(delta)) =
                    (str_at(params, "/itemId"), str_at(params, "/delta"))
                {
                    super::append_output(cx.thread, &format!("cx-{item}"), delta);
                }
            }
            "turn/plan/updated" => {
                let turn = str_at(params, "/turnId").unwrap_or("turn");
                let steps: Vec<Value> = params
                    .get("plan")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|step| {
                        json!({
                            "text": step.get("step"),
                            "status": match str_at(step, "/status") {
                                Some("completed") => "done",
                                Some("inProgress") => "running",
                                _ => "pending",
                            },
                        })
                    })
                    .collect();
                cx.thread
                    .upsert(&format!("cx-plan-{turn}"), "plan", |entry| {
                        entry.insert("steps".into(), json!(steps));
                        entry.insert(
                            "explanation".into(),
                            params.get("explanation").cloned().unwrap_or_default(),
                        );
                    });
            }
            "thread/tokenUsage/updated" => {
                let usage = params.get("tokenUsage").cloned().unwrap_or_default();
                cx.thread.data.usage = json!({
                    "inputTokens": usage.pointer("/total/inputTokens"),
                    "outputTokens": usage.pointer("/total/outputTokens"),
                    "totalTokens": usage.pointer("/total/totalTokens"),
                    "contextUsed": usage.pointer("/last/totalTokens"),
                    "contextWindow": usage.get("modelContextWindow"),
                });
                cx.thread.bump();
            }
            "thread/name/updated" => {
                if let Some(name) = str_at(params, "/name").or(str_at(params, "/threadName")) {
                    if !cx.thread.data.title_manual && !name.is_empty() {
                        cx.thread.data.title = name.to_string();
                        cx.thread.bump();
                    }
                }
            }
            "account/rateLimits/updated" => {
                if let Some(limits) = params.get("rateLimits") {
                    cx.quota = Some(quota(limits));
                }
            }
            "error" => {
                let message = str_at(params, "/error/message").unwrap_or("Codex 出错");
                if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    cx.thread.notice("warn", format!("{message}（正在重试）"));
                } else {
                    cx.thread.notice("error", message.to_string());
                }
            }
            "warning" | "configWarning" | "deprecationNotice" => {
                if let Some(message) = str_at(params, "/message").or(str_at(params, "/summary")) {
                    cx.thread.notice("warn", message.to_string());
                }
            }
            _ => {}
        }
    }

    fn on_request(&mut self, id: &Value, method: &str, params: &Value, cx: &mut Cx) {
        let item = format!("cx-approval-{}", super::rpc_key(id));
        let full = self.safety == "full";
        match method {
            "item/commandExecution/requestApproval" => {
                if full {
                    return Self::reply(cx, id, json!({ "decision": "accept" }));
                }
                let title = str_at(params, "/command").unwrap_or("运行命令").to_string();
                let detail = [str_at(params, "/reason"), str_at(params, "/cwd")]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("\n");
                approval_item(
                    cx.thread,
                    &item,
                    "command",
                    &title,
                    &detail,
                    decision_options(),
                    None,
                );
                self.requests.insert(item, (id.clone(), Request::Command));
            }
            "item/fileChange/requestApproval" => {
                if full {
                    return Self::reply(cx, id, json!({ "decision": "accept" }));
                }
                let detail = str_at(params, "/reason").unwrap_or_default().to_string();
                let target = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .and_then(|raw| cx.thread.item(&format!("cx-{raw}")))
                    .and_then(|entry| {
                        entry
                            .get("tool")?
                            .get("title")?
                            .as_str()
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "修改文件".into());
                approval_item(
                    cx.thread,
                    &item,
                    "edit",
                    &target,
                    &detail,
                    decision_options(),
                    None,
                );
                self.requests
                    .insert(item, (id.clone(), Request::FileChange));
            }
            "item/permissions/requestApproval" => {
                let permissions = params.get("permissions").cloned().unwrap_or_default();
                if full {
                    return Self::reply(
                        cx,
                        id,
                        json!({ "permissions": permissions, "scope": "session" }),
                    );
                }
                let detail = [
                    str_at(params, "/reason").map(str::to_string),
                    Some(super::compact_json(Some(&permissions))),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("\n");
                let options = json!([
                    { "id": "turn", "label": "本轮允许", "tone": "primary" },
                    { "id": "session", "label": "本会话允许", "tone": "neutral" },
                    { "id": "decline", "label": "拒绝", "tone": "danger" },
                ]);
                approval_item(
                    cx.thread,
                    &item,
                    "permission",
                    "申请额外权限",
                    &detail,
                    options,
                    None,
                );
                self.requests
                    .insert(item, (id.clone(), Request::Permissions(permissions)));
            }
            "item/tool/requestUserInput" => {
                let questions: Vec<Value> = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|question| {
                        json!({
                            "id": question.get("id"),
                            "header": question.get("header"),
                            "question": question.get("question"),
                            "options": question.get("options").and_then(Value::as_array).map(|options| {
                                options.iter().map(|option| json!({
                                    "label": option.get("label"),
                                    "description": option.get("description"),
                                })).collect::<Vec<_>>()
                            }),
                            "other": question.get("isOther").and_then(Value::as_bool).unwrap_or(true),
                            "multiple": false,
                        })
                    })
                    .collect();
                let options = json!([
                    { "id": "answer", "label": "提交回答", "tone": "primary" },
                    { "id": "skip", "label": "跳过", "tone": "neutral" },
                ]);
                approval_item(
                    cx.thread,
                    &item,
                    "question",
                    "Codex 需要你的回答",
                    "",
                    options,
                    Some(json!(questions)),
                );
                self.requests.insert(item, (id.clone(), Request::Question));
            }
            "mcpServer/elicitation/request" => {
                cx.thread
                    .notice("warn", "MCP 服务请求填写表单，手机端暂不支持，已拒绝。");
                Self::reply(cx, id, json!({ "action": "decline" }));
            }
            _ => Self::reply_error(cx, id, "QingCode 手机端不支持该请求"),
        }
    }
}

fn decision_options() -> Value {
    json!([
        { "id": "accept", "label": "允许", "tone": "primary" },
        { "id": "acceptForSession", "label": "本会话允许", "tone": "neutral" },
        { "id": "decline", "label": "拒绝", "tone": "danger" },
    ])
}

fn tool_status(status: &str) -> &'static str {
    match status {
        "completed" => "done",
        "failed" => "failed",
        "declined" => "declined",
        _ => "running",
    }
}

fn window_label(minutes: Option<i64>, fallback: &str) -> String {
    match minutes {
        Some(300) => "5 小时".into(),
        Some(10080) => "每周".into(),
        Some(minutes) if minutes % 1440 == 0 => format!("{} 天", minutes / 1440),
        Some(minutes) if minutes % 60 == 0 => format!("{} 小时", minutes / 60),
        Some(minutes) => format!("{minutes} 分钟"),
        None => fallback.into(),
    }
}

/// Codex 额度快照 → 统一格式。
pub fn quota(snapshot: &Value) -> Value {
    let windows: Vec<Value> = [("primary", "短期"), ("secondary", "长期")]
        .into_iter()
        .filter_map(|(key, fallback)| {
            let window = snapshot.get(key).filter(|window| !window.is_null())?;
            Some(json!({
                "label": window_label(window.get("windowDurationMins").and_then(Value::as_i64), fallback),
                "percent": window.get("usedPercent"),
                "resetsAt": window.get("resetsAt"),
            }))
        })
        .collect();
    json!({
        "plan": snapshot.get("planType"),
        "windows": windows,
        "reached": snapshot.get("rateLimitReachedType"),
    })
}

impl Adapter for Codex {
    fn launch(&self) -> Launch {
        Launch {
            program: "codex".into(),
            args: vec!["app-server".into()],
            env: Vec::new(),
        }
    }

    fn start(&mut self, cx: &mut Cx) {
        self.request(
            cx,
            "initialize",
            json!({ "clientInfo": { "name": "qingcode", "title": "QingCode", "version": env!("CARGO_PKG_VERSION") } }),
            Pending::Initialize,
        );
    }

    fn on_line(&mut self, message: Value, cx: &mut Cx) {
        let method = message.get("method").and_then(Value::as_str);
        match (message.get("id"), method) {
            (Some(id), Some(method)) => {
                let params = message.get("params").cloned().unwrap_or_default();
                self.on_request(id, method, &params, cx);
            }
            (Some(id), None) => {
                if let Some(id) = id.as_u64() {
                    self.on_response(id, &message, cx);
                }
            }
            (None, Some(method)) => {
                let params = message.get("params").cloned().unwrap_or_default();
                self.on_notification(method, &params, cx);
            }
            _ => {}
        }
    }

    fn send(&mut self, prompt: Prompt, cx: &mut Cx) -> Result<(), String> {
        if self.ready {
            self.start_turn(cx, prompt);
        } else {
            self.queue.push(prompt);
        }
        Ok(())
    }

    fn interrupt(&mut self, cx: &mut Cx) -> Result<(), String> {
        let (Some(session), Some(turn)) = (self.session.clone(), self.turn.clone()) else {
            return Err("当前没有进行中的任务。".into());
        };
        self.request(
            cx,
            "turn/interrupt",
            json!({ "threadId": session, "turnId": turn }),
            Pending::Other,
        );
        Ok(())
    }

    fn respond(
        &mut self,
        approval: &str,
        choice: &str,
        answers: &Value,
        cx: &mut Cx,
    ) -> Result<(), String> {
        let (id, request) = self
            .requests
            .remove(approval)
            .ok_or("该请求已处理或已失效。")?;
        let result = match request {
            Request::Command | Request::FileChange => {
                let decision = match choice {
                    "accept" | "acceptForSession" | "decline" | "cancel" => choice,
                    _ => "decline",
                };
                json!({ "decision": decision })
            }
            Request::Permissions(permissions) => match choice {
                "turn" | "session" => json!({ "permissions": permissions, "scope": choice }),
                _ => json!({ "permissions": {}, "scope": "turn" }),
            },
            Request::Question => {
                let mut result = serde_json::Map::new();
                if choice == "answer" {
                    if let Some(answers) = answers.as_object() {
                        for (question, value) in answers {
                            let list: Vec<Value> = match value {
                                Value::Array(values) => values.clone(),
                                Value::String(text) => vec![json!(text)],
                                _ => Vec::new(),
                            };
                            result.insert(question.clone(), json!({ "answers": list }));
                        }
                    }
                }
                json!({ "answers": result })
            }
        };
        Self::reply(cx, &id, result);
        approval_resolved(cx.thread, approval, choice, answers);
        Ok(())
    }

    fn configure(&mut self, key: &str, value: &str, _cx: &mut Cx) -> Result<bool, String> {
        match key {
            "safety" => self.safety = value.to_string(),
            "model" => self.model = Some(value.to_string()).filter(|value| !value.is_empty()),
            "effort" => self.effort = Some(value.to_string()).filter(|value| !value.is_empty()),
            _ => return Err("Codex 不支持该设置。".into()),
        }
        Ok(false)
    }

    fn refresh_usage(&mut self, cx: &mut Cx) {
        if self.ready {
            self.request(
                cx,
                "account/rateLimits/read",
                Value::Null,
                Pending::RateLimits,
            );
        }
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
        codex: &mut Codex,
        thread: &mut crate::agent::thread::Thread,
        line: Value,
    ) -> Vec<Value> {
        let mut cx = Cx::new(thread);
        codex.on_line(line, &mut cx);
        cx.out
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn ready() -> (Codex, crate::agent::thread::Thread) {
        let mut thread = sample(Provider::Codex);
        let mut codex = Codex::new("D:\\demo".into(), "auto".into(), None, None, None);
        {
            let mut cx = Cx::new(&mut thread);
            codex.start(&mut cx);
            assert_eq!(cx.out.len(), 1);
        }
        let out = feed(&mut codex, &mut thread, json!({ "id": 1, "result": {} }));
        assert_eq!(out[0]["method"], "initialized");
        assert_eq!(out[1]["method"], "thread/start");
        assert_eq!(out[1]["params"]["sandbox"], "workspace-write");
        feed(
            &mut codex,
            &mut thread,
            json!({ "id": 2, "result": { "thread": { "id": "th1" }, "model": "gpt-x" } }),
        );
        assert_eq!(thread.data.session.as_deref(), Some("th1"));
        assert_eq!(thread.status, Status::Idle);
        (codex, thread)
    }

    #[test]
    fn handshake_then_turn_carries_safety_policy_and_images() {
        let (mut codex, mut thread) = ready();
        let mut cx = Cx::new(&mut thread);
        codex.configure("safety", "full", &mut cx).unwrap();
        codex
            .send(
                Prompt {
                    text: "hi".into(),
                    images: vec![super::super::Image {
                        mime: "image/png".into(),
                        data: "AAA".into(),
                    }],
                },
                &mut cx,
            )
            .unwrap();
        let turn: Value = serde_json::from_str(cx.out.last().unwrap()).unwrap();
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(turn["params"]["approvalPolicy"], "never");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "dangerFullAccess");
        assert_eq!(
            turn["params"]["input"][1]["url"],
            "data:image/png;base64,AAA"
        );
    }

    #[test]
    fn prompts_sent_before_the_thread_opens_are_queued() {
        let mut thread = sample(Provider::Codex);
        let mut codex = Codex::new("/w".into(), "auto".into(), None, None, Some("old".into()));
        {
            let mut cx = Cx::new(&mut thread);
            codex.start(&mut cx);
            codex
                .send(
                    Prompt {
                        text: "queued".into(),
                        images: vec![],
                    },
                    &mut cx,
                )
                .unwrap();
            assert_eq!(cx.out.len(), 1);
        }
        let out = feed(&mut codex, &mut thread, json!({ "id": 1, "result": {} }));
        assert_eq!(out[1]["method"], "thread/resume");
        assert_eq!(out[1]["params"]["threadId"], "old");
        let out = feed(
            &mut codex,
            &mut thread,
            json!({ "id": 2, "error": { "message": "no rollout" } }),
        );
        assert_eq!(out[0]["method"], "thread/start");
        let id = out[0]["id"].as_u64().unwrap();
        let out = feed(
            &mut codex,
            &mut thread,
            json!({ "id": id, "result": { "thread": { "id": "new" } } }),
        );
        assert_eq!(out[0]["method"], "turn/start");
        assert_eq!(out[0]["params"]["input"][0]["text"], "queued");
    }

    #[test]
    fn streamed_items_become_chat_entries() {
        let (mut codex, mut thread) = ready();
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "turn/started", "params": { "turn": { "id": "u1" } } }),
        );
        assert_eq!(thread.status, Status::Running);
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "item/agentMessage/delta", "params": { "itemId": "m1", "delta": "你" } }),
        );
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "item/agentMessage/delta", "params": { "itemId": "m1", "delta": "好" } }),
        );
        assert_eq!(thread.item("cx-m1").unwrap()["text"], "你好");
        assert_eq!(thread.item("cx-m1").unwrap()["streaming"], true);
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "item/started", "params": { "item": { "id": "c1", "type": "commandExecution", "command": "ls", "status": "inProgress", "commandActions": [], "cwd": "/" } } }),
        );
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "item/commandExecution/outputDelta", "params": { "itemId": "c1", "delta": "a.txt\n" } }),
        );
        assert_eq!(thread.item("cx-c1").unwrap()["tool"]["output"], "a.txt\n");
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "item/completed", "params": { "item": { "id": "c1", "type": "commandExecution", "command": "ls", "status": "completed", "exitCode": 0, "aggregatedOutput": "a.txt\n", "commandActions": [], "cwd": "/" } } }),
        );
        assert_eq!(thread.item("cx-c1").unwrap()["tool"]["status"], "done");
        feed(
            &mut codex,
            &mut thread,
            json!({ "method": "item/completed", "params": { "item": { "id": "m1", "type": "agentMessage", "text": "你好！" } } }),
        );
        assert!(thread.item("cx-m1").unwrap().get("streaming").is_none());
        let out = feed(
            &mut codex,
            &mut thread,
            json!({ "method": "turn/completed", "params": { "turn": { "id": "u1", "status": "completed", "items": [] } } }),
        );
        assert_eq!(thread.status, Status::Idle);
        assert_eq!(out[0]["method"], "account/rateLimits/read");
    }

    #[test]
    fn approvals_are_forwarded_unless_full_access() {
        let (mut codex, mut thread) = ready();
        let out = feed(
            &mut codex,
            &mut thread,
            json!({ "id": 90, "method": "item/commandExecution/requestApproval", "params": { "itemId": "c1", "threadId": "th1", "turnId": "u1", "startedAtMs": 0, "command": "rm -rf build" } }),
        );
        assert!(out.is_empty());
        assert_eq!(thread.pending_approvals(), 1);
        let mut cx = Cx::new(&mut thread);
        codex
            .respond("cx-approval-90", "acceptForSession", &Value::Null, &mut cx)
            .unwrap();
        let reply: Value = serde_json::from_str(&cx.out[0]).unwrap();
        assert_eq!(
            reply,
            json!({ "id": 90, "result": { "decision": "acceptForSession" } })
        );
        assert!(codex
            .respond("cx-approval-90", "accept", &Value::Null, &mut cx)
            .is_err());
        drop(cx);
        assert_eq!(thread.pending_approvals(), 0);

        codex
            .configure("safety", "full", &mut Cx::new(&mut thread))
            .unwrap();
        let out = feed(
            &mut codex,
            &mut thread,
            json!({ "id": 91, "method": "item/fileChange/requestApproval", "params": { "itemId": "f1", "threadId": "th1", "turnId": "u1", "startedAtMs": 0 } }),
        );
        assert_eq!(out[0]["result"]["decision"], "accept");
        assert_eq!(thread.pending_approvals(), 0);
    }

    #[test]
    fn unknown_server_requests_get_an_error_reply() {
        let (mut codex, mut thread) = ready();
        let out = feed(
            &mut codex,
            &mut thread,
            json!({ "id": "x", "method": "attestation/generate", "params": {} }),
        );
        assert_eq!(out[0]["id"], "x");
        assert!(out[0]["error"].is_object());
    }

    #[test]
    fn rate_limits_are_normalized_into_windows() {
        let quota = quota(&json!({
            "planType": "plus",
            "primary": { "usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1800000000 },
            "secondary": { "usedPercent": 40, "windowDurationMins": 10080 },
        }));
        assert_eq!(quota["plan"], "plus");
        assert_eq!(quota["windows"][0]["label"], "5 小时");
        assert_eq!(quota["windows"][1]["label"], "每周");
        assert_eq!(quota["windows"][1]["percent"], 40);
    }
}
