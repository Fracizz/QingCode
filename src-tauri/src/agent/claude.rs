//! Claude Code：`claude -p` 的 stream-json 双向协议。
//!
//! `--permission-prompts host` 让 Claude 把权限确认发给宿主（`control_request` /
//! `can_use_tool`），由手机在审批卡片里处理；AskUserQuestion 与计划审批同样走这里。
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::process::Launch;
use super::thread::{clip_head, clip_tail, Status, MAX_TOOL_OUTPUT};
use super::{approval_item, approval_resolved, str_at, Adapter, Cx, Prompt};

pub const SAFETY: &[(&str, &str, &str)] = &[
    ("default", "每次询问", "编辑文件和运行命令前在手机上确认"),
    (
        "acceptEdits",
        "自动编辑",
        "自动接受文件编辑；运行命令前在手机上确认",
    ),
    ("plan", "只规划", "只读分析并给出计划，批准后再动手"),
    (
        "bypassPermissions",
        "完全访问",
        "不再询问，直接编辑文件和运行命令",
    ),
];
pub const DEFAULT_SAFETY: &str = "default";

enum Request {
    Tool { input: Value, suggestions: Value },
    Question { input: Value },
    Plan { input: Value },
}

pub struct Claude {
    safety: String,
    model: Option<String>,
    effort: Option<String>,
    session: Option<String>,
    next_id: u64,
    ready: bool,
    queue: Vec<Prompt>,
    /// 已发送、尚未收到 `result` 的用户消息数。
    inflight: usize,
    /// 流式消息 id 与内容块序号 → 条目 id。
    blocks: HashMap<(String, u64), String>,
    message: Option<String>,
    streamed: HashSet<String>,
    requests: HashMap<String, (String, Request)>,
    last_usage_refresh: Option<Instant>,
}

impl Claude {
    pub fn new(
        safety: String,
        model: Option<String>,
        effort: Option<String>,
        session: Option<String>,
    ) -> Self {
        Self {
            safety,
            model,
            effort,
            session,
            next_id: 0,
            ready: false,
            queue: Vec::new(),
            inflight: 0,
            blocks: HashMap::new(),
            message: None,
            streamed: HashSet::new(),
            requests: HashMap::new(),
            last_usage_refresh: None,
        }
    }

    fn control(&mut self, cx: &mut Cx, kind: &str, mut request: Value) {
        self.next_id += 1;
        request["subtype"] = json!(kind);
        cx.send(json!({
            "type": "control_request",
            "request_id": format!("{kind}-{}", self.next_id),
            "request": request,
        }));
    }

    fn respond_control(cx: &mut Cx, request_id: &str, response: Value) {
        cx.send(json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request_id, "response": response },
        }));
    }

    fn refuse_control(cx: &mut Cx, request_id: &str, error: &str) {
        cx.send(json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": request_id, "error": error },
        }));
    }

    fn write_prompt(&mut self, cx: &mut Cx, prompt: Prompt) {
        let mut content = Vec::new();
        for image in &prompt.images {
            content.push(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": image.mime, "data": image.data },
            }));
        }
        if !prompt.text.is_empty() || content.is_empty() {
            content.push(json!({ "type": "text", "text": prompt.text }));
        }
        self.inflight += 1;
        cx.send(json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
            "session_id": self.session.clone().unwrap_or_default(),
        }));
    }

    fn refresh(&mut self, cx: &mut Cx, force: bool) {
        let recent = self
            .last_usage_refresh
            .is_some_and(|time| time.elapsed() < Duration::from_secs(20));
        if self.ready && (force || !recent) {
            self.last_usage_refresh = Some(Instant::now());
            self.control(cx, "get_usage", json!({}));
        }
    }

    fn on_stream(&mut self, event: &Value, cx: &mut Cx) {
        match str_at(event, "/type").unwrap_or_default() {
            "message_start" => {
                self.message = str_at(event, "/message/id").map(str::to_string);
            }
            "content_block_start" => {
                let (Some(message), Some(index)) = (
                    self.message.clone(),
                    event.get("index").and_then(Value::as_u64),
                ) else {
                    return;
                };
                let block = event.get("content_block").cloned().unwrap_or_default();
                match str_at(&block, "/type").unwrap_or_default() {
                    "text" | "thinking" => {
                        let kind = if str_at(&block, "/type") == Some("text") {
                            "assistant"
                        } else {
                            "reasoning"
                        };
                        let id = format!("cl-{message}-{index}");
                        self.streamed.insert(message.clone());
                        cx.thread.upsert(&id, kind, |item| {
                            item.insert("streaming".into(), json!(true));
                        });
                        self.blocks.insert((message, index), id);
                    }
                    "tool_use" => {
                        if let Some(tool) = str_at(&block, "/id") {
                            let name = str_at(&block, "/name").unwrap_or("工具").to_string();
                            if name == "TodoWrite" {
                                return;
                            }
                            super::tool(cx.thread, &format!("cl-tool-{tool}"), |entry| {
                                if !entry.contains_key("category") {
                                    entry.insert("category".into(), json!(category(&name)));
                                    entry.insert("name".into(), json!(name));
                                    entry.insert("title".into(), json!(name));
                                }
                                entry.insert("status".into(), json!("running"));
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let (Some(message), Some(index)) = (
                    self.message.clone(),
                    event.get("index").and_then(Value::as_u64),
                ) else {
                    return;
                };
                let Some(id) = self.blocks.get(&(message, index)).cloned() else {
                    return;
                };
                match str_at(event, "/delta/type").unwrap_or_default() {
                    "text_delta" => cx.thread.append_text(
                        &id,
                        "assistant",
                        str_at(event, "/delta/text").unwrap_or_default(),
                    ),
                    "thinking_delta" => cx.thread.append_text(
                        &id,
                        "reasoning",
                        str_at(event, "/delta/thinking").unwrap_or_default(),
                    ),
                    _ => {}
                }
            }
            "content_block_stop" => {
                let (Some(message), Some(index)) = (
                    self.message.clone(),
                    event.get("index").and_then(Value::as_u64),
                ) else {
                    return;
                };
                if let Some(id) = self.blocks.remove(&(message, index)) {
                    cx.thread.upsert(&id, "", |item| {
                        item.remove("streaming");
                    });
                }
            }
            _ => {}
        }
    }

    fn on_assistant(&mut self, message: &Value, cx: &mut Cx) {
        let id = str_at(message, "/id").unwrap_or("msg").to_string();
        let streamed = self.streamed.contains(&id);
        if let Some(usage) = message.get("usage") {
            let used: u64 = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "output_tokens",
            ]
            .iter()
            .filter_map(|key| usage.get(*key).and_then(Value::as_u64))
            .sum();
            if used > 0 {
                set_usage(cx, "contextUsed", json!(used));
            }
        }
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (position, block) in blocks.iter().enumerate() {
            match str_at(block, "/type").unwrap_or_default() {
                "text" | "thinking" if !streamed => {
                    let text = block
                        .get("text")
                        .or(block.get("thinking"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let kind = if str_at(block, "/type") == Some("text") {
                        "assistant"
                    } else {
                        "reasoning"
                    };
                    if !text.trim().is_empty() {
                        cx.thread.upsert(
                            &format!("cl-{id}-a{position}-{}", cx.thread.data.rev),
                            kind,
                            |item| {
                                item.insert("text".into(), json!(text));
                            },
                        );
                    }
                }
                "tool_use" => self.on_tool_use(block, cx),
                _ => {}
            }
        }
    }

    fn on_tool_use(&mut self, block: &Value, cx: &mut Cx) {
        let (Some(tool), Some(name)) = (str_at(block, "/id"), str_at(block, "/name")) else {
            return;
        };
        let input = block.get("input").cloned().unwrap_or_default();
        if name == "TodoWrite" {
            let steps: Vec<Value> = input
                .get("todos")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|todo| {
                    json!({
                        "text": todo.get("content"),
                        "status": match str_at(todo, "/status") {
                            Some("completed") => "done",
                            Some("in_progress") => "running",
                            _ => "pending",
                        },
                    })
                })
                .collect();
            cx.thread.upsert("cl-todos", "plan", |item| {
                item.insert("steps".into(), json!(steps));
            });
            return;
        }
        let described = describe(name, &input);
        super::tool(cx.thread, &format!("cl-tool-{tool}"), |entry| {
            for (key, value) in described {
                entry.insert(key, value);
            }
            entry.insert("name".into(), json!(name));
            if !entry.contains_key("status") {
                entry.insert("status".into(), json!("running"));
            }
        });
    }

    fn on_user(&mut self, message: &Value, cx: &mut Cx) {
        let blocks = message
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for block in blocks {
            if str_at(&block, "/type") != Some("tool_result") {
                continue;
            }
            let Some(tool) = str_at(&block, "/tool_use_id") else {
                continue;
            };
            let id = format!("cl-tool-{tool}");
            if !cx.thread.has_item(&id) {
                continue;
            }
            let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
            let output = block
                .get("content")
                .map(super::content_text)
                .unwrap_or_default();
            super::tool(cx.thread, &id, |entry| {
                entry.insert(
                    "status".into(),
                    json!(if failed { "failed" } else { "done" }),
                );
                if !output.is_empty() {
                    entry.insert("output".into(), json!(clip_tail(&output, MAX_TOOL_OUTPUT)));
                }
            });
        }
    }

    fn on_result(&mut self, message: &Value, cx: &mut Cx) {
        self.inflight = self.inflight.saturating_sub(1);
        if let Some(session) = str_at(message, "/session_id") {
            self.session = Some(session.to_string());
            cx.thread.data.session = Some(session.to_string());
        }
        let failed = message.get("is_error").and_then(Value::as_bool) == Some(true)
            || str_at(message, "/subtype").is_some_and(|subtype| subtype != "success");
        if failed {
            let text = str_at(message, "/result")
                .map(str::to_string)
                .or_else(|| {
                    message
                        .get("errors")
                        .and_then(Value::as_array)
                        .map(|errors| {
                            errors
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                })
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "Claude 本轮未完成（{}）",
                        str_at(message, "/subtype").unwrap_or("error")
                    )
                });
            cx.thread.notice("error", text);
        }
        if let Some(cost) = message.get("total_cost_usd").and_then(Value::as_f64) {
            set_usage(cx, "cost", json!({ "amount": cost, "currency": "USD" }));
        }
        if let Some(usage) = message.get("usage") {
            let input: u64 = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ]
            .iter()
            .filter_map(|key| usage.get(*key).and_then(Value::as_u64))
            .sum();
            let total_input = cx
                .thread
                .data
                .usage
                .get("inputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + input;
            let output = usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let total_output = cx
                .thread
                .data
                .usage
                .get("outputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + output;
            set_usage(cx, "inputTokens", json!(total_input));
            set_usage(cx, "outputTokens", json!(total_output));
        }
        if let Some(window) = message
            .get("modelUsage")
            .and_then(Value::as_object)
            .and_then(|models| {
                models
                    .values()
                    .filter_map(|model| model.get("contextWindow")?.as_u64())
                    .max()
            })
        {
            set_usage(cx, "contextWindow", json!(window));
        }
        if self.inflight == 0 {
            cx.thread.settle("expired");
            cx.thread.set_status(Status::Idle);
        }
        cx.thread.dirty = true;
        self.refresh(cx, true);
    }

    fn on_control_request(&mut self, request_id: &str, request: &Value, cx: &mut Cx) {
        if str_at(request, "/subtype") != Some("can_use_tool") {
            return Self::refuse_control(cx, request_id, "QingCode 手机端不支持该请求");
        }
        let name = str_at(request, "/tool_name").unwrap_or("工具").to_string();
        let input = request.get("input").cloned().unwrap_or_default();
        let item = format!("cl-approval-{request_id}");
        match name.as_str() {
            "AskUserQuestion" => {
                let questions: Vec<Value> = input
                    .get("questions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|question| {
                        json!({
                            "id": question.get("question"),
                            "header": question.get("header"),
                            "question": question.get("question"),
                            "options": question.get("options"),
                            "other": true,
                            "multiple": question.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
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
                    "Claude 需要你的回答",
                    "",
                    options,
                    Some(json!(questions)),
                );
                self.requests
                    .insert(item, (request_id.to_string(), Request::Question { input }));
            }
            "ExitPlanMode" => {
                let plan = str_at(&input, "/plan").unwrap_or_default().to_string();
                let options = json!([
                    { "id": "acceptEdits", "label": "批准并自动编辑", "tone": "primary" },
                    { "id": "default", "label": "批准，逐项确认", "tone": "neutral" },
                    { "id": "keep", "label": "继续规划", "tone": "danger" },
                ]);
                approval_item(cx.thread, &item, "plan", "批准计划", &plan, options, None);
                self.requests
                    .insert(item, (request_id.to_string(), Request::Plan { input }));
            }
            _ => {
                if self.safety == "bypassPermissions" {
                    return Self::respond_control(
                        cx,
                        request_id,
                        json!({ "behavior": "allow", "updatedInput": input }),
                    );
                }
                let described: Map<String, Value> = describe(&name, &input);
                let title = described
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&name)
                    .to_string();
                let detail = [
                    str_at(request, "/decision_reason")
                        .or(str_at(request, "/reason"))
                        .map(str::to_string),
                    described
                        .get("detail")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                ]
                .into_iter()
                .flatten()
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
                let kind = match category(&name) {
                    "command" => "command",
                    "edit" => "edit",
                    _ => "tool",
                };
                let suggestions = request
                    .get("permission_suggestions")
                    .cloned()
                    .unwrap_or_default();
                let mut options =
                    vec![json!({ "id": "allow", "label": "允许", "tone": "primary" })];
                if suggestions.as_array().is_some_and(|list| !list.is_empty()) {
                    options.push(json!({ "id": "always", "label": "总是允许", "tone": "neutral" }));
                }
                options.push(json!({ "id": "deny", "label": "拒绝", "tone": "danger" }));
                let files = described.get("files").cloned();
                approval_item(
                    cx.thread,
                    &item,
                    kind,
                    &title,
                    &detail,
                    json!(options),
                    None,
                );
                if let Some(files) = files {
                    cx.thread.upsert(&item, "approval", |entry| {
                        entry.insert("files".into(), files);
                    });
                }
                self.requests.insert(
                    item,
                    (request_id.to_string(), Request::Tool { input, suggestions }),
                );
            }
        }
    }

    fn on_control_response(&mut self, response: &Value, cx: &mut Cx) {
        let request_id = str_at(response, "/request_id").unwrap_or_default();
        let failed = str_at(response, "/subtype") == Some("error");
        let body = response.get("response").cloned().unwrap_or_default();
        if request_id.starts_with("initialize-") {
            if failed {
                cx.thread.fail(format!(
                    "Claude 初始化失败：{}",
                    str_at(response, "/error").unwrap_or("未知错误")
                ));
                return;
            }
            let models: Vec<Value> = body
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|model| {
                    json!({
                        "id": model.get("value"),
                        "label": model.get("displayName"),
                        "description": model.get("description"),
                        "efforts": model.get("supportedEffortLevels"),
                    })
                })
                .collect();
            super::set_option(cx.thread, "models", json!(models));
            let commands: Vec<Value> = body
                .get("commands")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|command| {
                    Some(json!({
                        "name": command.get("name")?,
                        "description": clip_head(str_at(command, "/description").unwrap_or_default(), 80),
                    }))
                })
                .collect();
            super::set_option(cx.thread, "commands", json!(commands));
            self.ready = true;
            let queue = std::mem::take(&mut self.queue);
            if queue.is_empty() {
                cx.thread.set_status(Status::Idle);
            }
            for prompt in queue {
                self.write_prompt(cx, prompt);
            }
            self.refresh(cx, true);
        } else if request_id.starts_with("get_usage-") {
            if !failed {
                cx.quota = Some(quota(&body));
            }
        } else if failed {
            cx.thread.notice(
                "warn",
                str_at(response, "/error")
                    .unwrap_or("Claude 拒绝了该设置")
                    .to_string(),
            );
        }
    }
}

fn set_usage(cx: &mut Cx, key: &str, value: Value) {
    if !cx.thread.data.usage.is_object() {
        cx.thread.data.usage = json!({});
    }
    cx.thread.data.usage[key] = value;
    cx.thread.bump();
}

pub fn category(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" | "KillShell" | "PowerShell" => "command",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "edit",
        "Read" | "LS" => "read",
        "Grep" | "Glob" | "ToolSearch" => "search",
        "WebFetch" | "WebSearch" => "web",
        "Task" | "Agent" => "agent",
        name if name.starts_with("mcp__") => "mcp",
        _ => "other",
    }
}

fn diff_lines(old: &str, new: &str) -> String {
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

/// 工具调用 → 卡片字段（标题、说明、文件改动）。
pub fn describe(name: &str, input: &Value) -> Map<String, Value> {
    let text = |key: &str| {
        str_at(input, &format!("/{key}"))
            .unwrap_or_default()
            .to_string()
    };
    let mut entry = Map::new();
    entry.insert("category".into(), json!(category(name)));
    let (title, detail) = match name {
        "Bash" | "PowerShell" => (text("command"), text("description")),
        "Read" | "Write" | "Edit" | "MultiEdit" => (text("file_path"), String::new()),
        "NotebookEdit" => (text("notebook_path"), String::new()),
        "Grep" => (text("pattern"), text("path")),
        "Glob" => (text("pattern"), text("path")),
        "WebFetch" => (text("url"), text("prompt")),
        "WebSearch" => (text("query"), String::new()),
        "Task" | "Agent" => (text("description"), clip_head(&text("prompt"), 300)),
        name if name.starts_with("mcp__") => {
            let mut parts = name.trim_start_matches("mcp__").splitn(2, "__");
            let server = parts.next().unwrap_or_default();
            let tool = parts.next().unwrap_or_default();
            (
                format!("{server} · {tool}"),
                super::compact_json(Some(input)),
            )
        }
        _ => (name.to_string(), super::compact_json(Some(input))),
    };
    let diff = match name {
        "Edit" => Some(diff_lines(&text("old_string"), &text("new_string"))),
        "Write" => Some(diff_lines("", &text("content"))),
        "MultiEdit" => Some(
            input
                .get("edits")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|edit| {
                    diff_lines(
                        str_at(edit, "/old_string").unwrap_or_default(),
                        str_at(edit, "/new_string").unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>()
                .join("…\n"),
        ),
        _ => None,
    };
    if let Some(diff) = diff {
        entry.insert(
            "files".into(),
            json!([{ "path": title, "change": if name == "Write" { "add" } else { "update" }, "diff": diff }]),
        );
    }
    entry.insert(
        "title".into(),
        json!(if title.is_empty() {
            name.to_string()
        } else {
            title
        }),
    );
    if !detail.is_empty() {
        entry.insert("detail".into(), json!(detail));
    }
    entry
}

/// `get_usage` → 统一额度格式。
pub fn quota(usage: &Value) -> Value {
    let label = |kind: &str| match kind {
        "session" | "five_hour" => "5 小时".to_string(),
        "weekly_all" | "seven_day" => "每周".to_string(),
        "weekly_opus" | "seven_day_opus" => "每周 · Opus".to_string(),
        "weekly_sonnet" | "seven_day_sonnet" => "每周 · Sonnet".to_string(),
        other => other.replace('_', " "),
    };
    let mut windows: Vec<Value> = usage
        .pointer("/rate_limits/limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|limit| {
            json!({
                "label": label(str_at(limit, "/kind").unwrap_or("limit")),
                "percent": limit.get("percent"),
                "resetsAt": limit.get("resets_at"),
                "severity": limit.get("severity"),
            })
        })
        .collect();
    if windows.is_empty() {
        for key in ["five_hour", "seven_day"] {
            if let Some(window) = usage
                .pointer(&format!("/rate_limits/{key}"))
                .filter(|window| window.is_object())
            {
                windows.push(json!({
                    "label": label(key),
                    "percent": window.get("utilization"),
                    "resetsAt": window.get("resets_at"),
                }));
            }
        }
    }
    let mut result = json!({ "plan": usage.get("subscription_type"), "windows": windows });
    if usage.get("rate_limits_available").and_then(Value::as_bool) == Some(false)
        && windows_empty(&result)
    {
        result["note"] = json!("当前账号类型不提供额度窗口（按 API 用量计费）。");
    }
    result
}

fn windows_empty(value: &Value) -> bool {
    value
        .get("windows")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
}

impl Adapter for Claude {
    fn launch(&self) -> Launch {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompts",
            "host",
            "--permission-mode",
        ]
        .map(String::from)
        .to_vec();
        args.push(self.safety.clone());
        if let Some(model) = &self.model {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(effort) = &self.effort {
            args.extend(["--effort".into(), effort.clone()]);
        }
        if let Some(session) = &self.session {
            args.extend(["--resume".into(), session.clone()]);
        }
        Launch {
            program: "claude".into(),
            args,
            env: Vec::new(),
        }
    }

    fn start(&mut self, cx: &mut Cx) {
        self.control(cx, "initialize", json!({}));
    }

    fn on_line(&mut self, message: Value, cx: &mut Cx) {
        let nested = message
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null());
        match str_at(&message, "/type").unwrap_or_default() {
            "stream_event" if !nested => {
                if let Some(event) = message.get("event") {
                    self.on_stream(event, cx);
                }
            }
            "assistant" if !nested => {
                if let Some(inner) = message.get("message") {
                    self.on_assistant(inner, cx);
                }
            }
            "user" if !nested => {
                if let Some(inner) = message.get("message") {
                    self.on_user(inner, cx);
                }
            }
            "result" => self.on_result(&message, cx),
            "system" => match str_at(&message, "/subtype") {
                Some("init") => {
                    if let Some(session) = str_at(&message, "/session_id") {
                        self.session = Some(session.to_string());
                        cx.thread.data.session = Some(session.to_string());
                    }
                    if let Some(model) = str_at(&message, "/model") {
                        if self.model.is_none() {
                            cx.thread.data.model = Some(model.to_string());
                        }
                    }
                    cx.thread.bump();
                }
                Some("compact_boundary") => cx.thread.notice("info", "上下文已压缩"),
                _ => {}
            },
            "rate_limit_event" => self.refresh(cx, false),
            "control_request" => {
                let request_id = str_at(&message, "/request_id")
                    .unwrap_or_default()
                    .to_string();
                let request = message.get("request").cloned().unwrap_or_default();
                self.on_control_request(&request_id, &request, cx);
            }
            "control_response" => {
                if let Some(response) = message.get("response") {
                    self.on_control_response(response, cx);
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
        if self.inflight == 0 {
            return Err("当前没有进行中的任务。".into());
        }
        self.control(cx, "interrupt", json!({}));
        Ok(())
    }

    fn respond(
        &mut self,
        approval: &str,
        choice: &str,
        answers: &Value,
        cx: &mut Cx,
    ) -> Result<(), String> {
        let (request_id, request) = self
            .requests
            .remove(approval)
            .ok_or("该请求已处理或已失效。")?;
        let deny = |message: &str| json!({ "behavior": "deny", "message": message });
        let response = match request {
            Request::Tool { input, suggestions } => match choice {
                "allow" => json!({ "behavior": "allow", "updatedInput": input }),
                "always" => {
                    json!({ "behavior": "allow", "updatedInput": input, "updatedPermissions": suggestions })
                }
                _ => deny("用户在手机上拒绝了该操作。"),
            },
            Request::Question { mut input } => {
                if choice == "answer" {
                    let mut map = Map::new();
                    if let Some(answers) = answers.as_object() {
                        for (question, value) in answers {
                            let text = match value {
                                Value::Array(values) => values
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                Value::String(text) => text.clone(),
                                _ => String::new(),
                            };
                            map.insert(question.clone(), json!(text));
                        }
                    }
                    input["answers"] = Value::Object(map);
                    json!({ "behavior": "allow", "updatedInput": input })
                } else {
                    deny("用户跳过了提问，请按你的判断继续。")
                }
            }
            Request::Plan { input } => match choice {
                "acceptEdits" | "default" => {
                    self.safety = choice.to_string();
                    cx.thread.data.safety = choice.to_string();
                    cx.thread.bump();
                    self.control(cx, "set_permission_mode", json!({ "mode": choice }));
                    json!({ "behavior": "allow", "updatedInput": input })
                }
                _ => deny("用户希望继续完善计划，请根据后续反馈修改。"),
            },
        };
        Self::respond_control(cx, &request_id, response);
        approval_resolved(cx.thread, approval, choice, answers);
        Ok(())
    }

    fn configure(&mut self, key: &str, value: &str, cx: &mut Cx) -> Result<bool, String> {
        match key {
            "safety" => {
                self.safety = value.to_string();
                if self.ready {
                    self.control(cx, "set_permission_mode", json!({ "mode": value }));
                }
                Ok(false)
            }
            "model" => {
                self.model = Some(value.to_string()).filter(|value| !value.is_empty());
                if self.ready {
                    self.control(cx, "set_model", json!({ "model": self.model }));
                }
                Ok(false)
            }
            // 推理强度只能通过启动参数设置：空闲时重启进程，下一条消息自动恢复会话。
            "effort" => {
                self.effort = Some(value.to_string()).filter(|value| !value.is_empty());
                Ok(true)
            }
            _ => Err("Claude 不支持该设置。".into()),
        }
    }

    fn refresh_usage(&mut self, cx: &mut Cx) {
        self.refresh(cx, true);
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
        claude: &mut Claude,
        thread: &mut crate::agent::thread::Thread,
        line: Value,
    ) -> Vec<Value> {
        let mut cx = Cx::new(thread);
        claude.on_line(line, &mut cx);
        cx.out
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn ready(safety: &str) -> (Claude, crate::agent::thread::Thread) {
        let mut thread = sample(Provider::Claude);
        let mut claude = Claude::new(safety.into(), None, None, None);
        let request_id = {
            let mut cx = Cx::new(&mut thread);
            claude.start(&mut cx);
            let init: Value = serde_json::from_str(&cx.out[0]).unwrap();
            assert_eq!(init["request"]["subtype"], "initialize");
            init["request_id"].as_str().unwrap().to_string()
        };
        let out = feed(
            &mut claude,
            &mut thread,
            json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": request_id, "response": {
                    "models": [{ "value": "opus", "displayName": "Opus" }],
                    "commands": [{ "name": "review", "description": "Review" }],
                } },
            }),
        );
        assert_eq!(out[0]["request"]["subtype"], "get_usage");
        assert_eq!(thread.options["models"][0]["id"], "opus");
        (claude, thread)
    }

    #[test]
    fn launch_arguments_follow_safety_model_and_resume() {
        let claude = Claude::new(
            "acceptEdits".into(),
            Some("sonnet".into()),
            Some("high".into()),
            Some("s1".into()),
        );
        let args = claude.launch().args;
        let joined = args.join(" ");
        assert!(joined.contains("--permission-prompts host"));
        assert!(joined.contains("--permission-mode acceptEdits"));
        assert!(joined.contains("--model sonnet"));
        assert!(joined.contains("--effort high"));
        assert!(joined.ends_with("--resume s1"));
    }

    #[test]
    fn streaming_text_tools_and_result_update_the_thread() {
        let (mut claude, mut thread) = ready("default");
        {
            let mut cx = Cx::new(&mut thread);
            claude
                .send(
                    Prompt {
                        text: "hi".into(),
                        images: vec![],
                    },
                    &mut cx,
                )
                .unwrap();
            let user: Value = serde_json::from_str(&cx.out[0]).unwrap();
            assert_eq!(user["message"]["content"][0]["text"], "hi");
        }
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "system", "subtype": "init", "session_id": "s1", "model": "claude-opus" }),
        );
        assert_eq!(thread.data.session.as_deref(), Some("s1"));
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "id": "m1" } } }),
        );
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "text" } } }),
        );
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "看一下" } } }),
        );
        assert_eq!(thread.item("cl-m1-0").unwrap()["text"], "看一下");
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 } }),
        );
        assert!(thread.item("cl-m1-0").unwrap().get("streaming").is_none());
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "assistant", "message": { "id": "m1", "content": [
            { "type": "text", "text": "看一下" },
            { "type": "tool_use", "id": "tu1", "name": "Bash", "input": { "command": "ls", "description": "列出文件" } },
        ] } }),
        );
        assert_eq!(thread.item("cl-tool-tu1").unwrap()["tool"]["title"], "ls");
        assert_eq!(
            thread
                .data
                .items
                .iter()
                .filter(|item| item["kind"] == "assistant")
                .count(),
            1
        );
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "tu1", "content": [{ "type": "text", "text": "a.txt" }] },
        ] } }),
        );
        assert_eq!(
            thread.item("cl-tool-tu1").unwrap()["tool"]["output"],
            "a.txt"
        );
        assert_eq!(
            thread.item("cl-tool-tu1").unwrap()["tool"]["status"],
            "done"
        );
        let out = feed(
            &mut claude,
            &mut thread,
            json!({ "type": "result", "subtype": "success", "total_cost_usd": 0.02, "usage": { "input_tokens": 10, "output_tokens": 5 } }),
        );
        assert_eq!(thread.status, Status::Idle);
        assert_eq!(thread.data.usage["cost"]["amount"], 0.02);
        assert_eq!(out[0]["request"]["subtype"], "get_usage");
    }

    #[test]
    fn tool_permission_is_forwarded_and_answered() {
        let (mut claude, mut thread) = ready("default");
        let out = feed(
            &mut claude,
            &mut thread,
            json!({ "type": "control_request", "request_id": "r1", "request": {
            "subtype": "can_use_tool", "tool_name": "Edit",
            "input": { "file_path": "a.rs", "old_string": "a", "new_string": "b" },
            "permission_suggestions": [{ "type": "setMode", "mode": "acceptEdits" }],
        } }),
        );
        assert!(out.is_empty());
        let approval = thread.item("cl-approval-r1").unwrap().clone();
        assert_eq!(approval["approval"]["type"], "edit");
        assert_eq!(approval["approval"]["options"].as_array().unwrap().len(), 3);
        assert_eq!(approval["files"][0]["diff"], "-a\n+b\n");
        let mut cx = Cx::new(&mut thread);
        claude
            .respond("cl-approval-r1", "always", &Value::Null, &mut cx)
            .unwrap();
        let reply: Value = serde_json::from_str(&cx.out[0]).unwrap();
        assert_eq!(reply["response"]["request_id"], "r1");
        assert_eq!(reply["response"]["response"]["behavior"], "allow");
        assert_eq!(
            reply["response"]["response"]["updatedPermissions"][0]["mode"],
            "acceptEdits"
        );
    }

    #[test]
    fn bypass_mode_allows_tools_but_still_asks_questions() {
        let (mut claude, mut thread) = ready("bypassPermissions");
        let out = feed(
            &mut claude,
            &mut thread,
            json!({ "type": "control_request", "request_id": "r2", "request": {
            "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "rm x" },
        } }),
        );
        assert_eq!(out[0]["response"]["response"]["behavior"], "allow");
        let out = feed(
            &mut claude,
            &mut thread,
            json!({ "type": "control_request", "request_id": "r3", "request": {
            "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
            "input": { "questions": [{ "question": "用哪个库？", "header": "库", "options": [{ "label": "A" }, { "label": "B" }], "multiSelect": false }] },
        } }),
        );
        assert!(out.is_empty());
        let mut cx = Cx::new(&mut thread);
        claude
            .respond(
                "cl-approval-r3",
                "answer",
                &json!({ "用哪个库？": ["B"] }),
                &mut cx,
            )
            .unwrap();
        let reply: Value = serde_json::from_str(&cx.out[0]).unwrap();
        assert_eq!(
            reply["response"]["response"]["updatedInput"]["answers"]["用哪个库？"],
            "B"
        );
    }

    #[test]
    fn plan_approval_switches_permission_mode() {
        let (mut claude, mut thread) = ready("plan");
        feed(
            &mut claude,
            &mut thread,
            json!({ "type": "control_request", "request_id": "r4", "request": {
            "subtype": "can_use_tool", "tool_name": "ExitPlanMode", "input": { "plan": "1. 改代码" },
        } }),
        );
        let mut cx = Cx::new(&mut thread);
        claude
            .respond("cl-approval-r4", "acceptEdits", &Value::Null, &mut cx)
            .unwrap();
        let mode: Value = serde_json::from_str(&cx.out[0]).unwrap();
        assert_eq!(mode["request"]["subtype"], "set_permission_mode");
        assert_eq!(mode["request"]["mode"], "acceptEdits");
        drop(cx);
        assert_eq!(thread.data.safety, "acceptEdits");
    }

    #[test]
    fn usage_limits_are_normalized() {
        let quota = quota(&json!({
            "subscription_type": "pro",
            "rate_limits": { "limits": [
                { "kind": "session", "percent": 22, "resets_at": "2026-11-04T18:49:59Z" },
                { "kind": "weekly_all", "percent": 42, "resets_at": "2026-11-08T08:59:59Z" },
            ] },
        }));
        assert_eq!(quota["plan"], "pro");
        assert_eq!(quota["windows"][0]["label"], "5 小时");
        assert_eq!(quota["windows"][1]["percent"], 42);
    }

    #[test]
    fn unsupported_control_requests_are_refused() {
        let (mut claude, mut thread) = ready("default");
        let out = feed(
            &mut claude,
            &mut thread,
            json!({ "type": "control_request", "request_id": "h1", "request": { "subtype": "hook_callback" } }),
        );
        assert_eq!(out[0]["response"]["subtype"], "error");
    }
}
