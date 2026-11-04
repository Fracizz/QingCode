//! 对话数据模型：三家 Agent 的原生事件都归并成同一套「条目」（item）。
//!
//! 每次修改条目或对话状态都会递增 `rev`，并把该条目的 `rev` 设为新值；手机按
//! `from` 拉取 `rev > from` 的条目即可增量合并，断线重连也不需要事件重放。
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{now_ms, AgentProject, Provider};

/// 单个对话最多保留的条目数；超出后丢弃最旧的条目。
pub const MAX_ITEMS: usize = 1500;
/// 首次同步只返回最近的条目，避免长对话一次传输过大。
pub const SYNC_ITEMS: usize = 300;
/// 工具输出只保留末尾，完整输出仍在 Agent 自己的会话记录里。
pub const MAX_TOOL_OUTPUT: usize = 12 * 1024;
const MAX_TEXT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// 进程启动、握手中。
    Starting,
    /// 进程在线，等待用户输入。
    Idle,
    /// 正在执行一轮对话。
    Running,
    /// 进程未运行；发送消息时自动恢复会话。
    Closed,
    /// 启动或运行失败，详情见 `error`。
    Error,
}

/// 持久化到磁盘的对话内容。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadData {
    pub id: String,
    pub provider: Provider,
    pub project: AgentProject,
    pub title: String,
    #[serde(default)]
    pub title_manual: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub safety: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    /// Agent 自己的会话 ID（Codex thread id / Claude session id / OpenCode session id）。
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub usage: Value,
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub rev: u64,
}

pub struct Thread {
    pub data: ThreadData,
    pub status: Status,
    pub error: Option<String>,
    /// 运行时从 Agent 读取的选项（模型、推理强度、模式、斜杠命令）。
    pub options: Value,
    index: HashMap<String, usize>,
    /// 内容有变化、需要写盘。
    pub dirty: bool,
}

impl Thread {
    pub fn new(data: ThreadData, status: Status) -> Self {
        let mut thread = Self {
            data,
            status,
            error: None,
            options: Value::Null,
            index: HashMap::new(),
            dirty: false,
        };
        thread.reindex();
        thread
    }

    fn reindex(&mut self) {
        self.index = self
            .data
            .items
            .iter()
            .enumerate()
            .filter_map(|(position, item)| Some((item.get("id")?.as_str()?.to_string(), position)))
            .collect();
    }

    pub fn bump(&mut self) -> u64 {
        self.data.rev += 1;
        self.data.updated_at = now_ms();
        self.dirty = true;
        self.data.rev
    }

    pub fn has_item(&self, id: &str) -> bool {
        self.index.contains_key(id)
    }

    pub fn item(&self, id: &str) -> Option<&Map<String, Value>> {
        self.index
            .get(id)
            .and_then(|position| self.data.items[*position].as_object())
    }

    /// 创建或修改条目。新条目带 `id`、`kind`、`time`；每次修改刷新 `rev`。
    pub fn upsert(&mut self, id: &str, kind: &str, change: impl FnOnce(&mut Map<String, Value>)) {
        let rev = self.bump();
        let position = match self.index.get(id) {
            Some(position) => *position,
            None => {
                self.data
                    .items
                    .push(json!({ "id": id, "kind": kind, "time": now_ms() }));
                let position = self.data.items.len() - 1;
                self.index.insert(id.to_string(), position);
                position
            }
        };
        if let Some(item) = self.data.items[position].as_object_mut() {
            change(item);
            item.insert("rev".into(), json!(rev));
        }
        self.prune();
    }

    /// 向条目的文本字段追加增量（流式回复、命令输出）。
    pub fn append(&mut self, id: &str, kind: &str, field: &str, delta: &str, limit: usize) {
        if delta.is_empty() {
            return;
        }
        self.upsert(id, kind, |item| {
            let mut text = item
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            text.push_str(delta);
            item.insert(field.into(), json!(clip_tail(&text, limit)));
        });
    }

    pub fn append_text(&mut self, id: &str, kind: &str, delta: &str) {
        self.append(id, kind, "text", delta, MAX_TEXT);
    }

    pub fn notice(&mut self, level: &str, text: impl Into<String>) {
        let id = format!("n-{}", uuid::Uuid::new_v4().simple());
        let text = text.into();
        self.upsert(&id, "notice", |item| {
            item.insert("level".into(), json!(level));
            item.insert("text".into(), json!(text));
        });
    }

    pub fn set_status(&mut self, status: Status) {
        if self.status != status {
            self.status = status;
            if status != Status::Error {
                self.error = None;
            }
            self.bump();
        }
    }

    pub fn fail(&mut self, error: impl Into<String>) {
        let error = error.into();
        self.status = Status::Error;
        self.notice("error", error.clone());
        self.error = Some(error);
        self.bump();
    }

    pub fn set_title_from(&mut self, text: &str) {
        if self.data.title_manual || !self.data.title.is_empty() {
            return;
        }
        let line = text.lines().map(str::trim).find(|line| !line.is_empty());
        if let Some(line) = line {
            self.data.title = clip_head(line, 60);
            self.bump();
        }
    }

    /// 等待用户处理的审批或提问数量。
    pub fn pending_approvals(&self) -> usize {
        self.data
            .items
            .iter()
            .filter(|item| {
                item.get("kind").and_then(Value::as_str) == Some("approval")
                    && item.pointer("/approval/state").and_then(Value::as_str) == Some("pending")
            })
            .count()
    }

    /// 进程退出或中断时，把仍在等待的审批标为失效，流式条目标为结束。
    pub fn settle(&mut self, approval_state: &str) {
        let pending: Vec<String> = self
            .data
            .items
            .iter()
            .filter(|item| {
                (item.get("kind").and_then(Value::as_str) == Some("approval")
                    && item.pointer("/approval/state").and_then(Value::as_str) == Some("pending"))
                    || item.get("streaming").and_then(Value::as_bool) == Some(true)
                    || item.pointer("/tool/status").and_then(Value::as_str) == Some("running")
            })
            .filter_map(|item| Some(item.get("id")?.as_str()?.to_string()))
            .collect();
        for id in pending {
            self.upsert(&id, "", |item| {
                item.remove("streaming");
                if let Some(approval) = item.get_mut("approval").and_then(Value::as_object_mut) {
                    if approval.get("state").and_then(Value::as_str) == Some("pending") {
                        approval.insert("state".into(), json!(approval_state));
                    }
                }
                if let Some(tool) = item.get_mut("tool").and_then(Value::as_object_mut) {
                    if tool.get("status").and_then(Value::as_str) == Some("running") {
                        tool.insert("status".into(), json!("stopped"));
                    }
                }
            });
        }
    }

    fn prune(&mut self) {
        if self.data.items.len() <= MAX_ITEMS {
            return;
        }
        let excess = self.data.items.len() - MAX_ITEMS;
        self.data.items.drain(..excess);
        self.reindex();
    }

    /// 最近一条助手回复的开头，用于对话列表预览。
    pub fn preview(&self) -> String {
        self.data
            .items
            .iter()
            .rev()
            .find_map(|item| {
                let kind = item.get("kind")?.as_str()?;
                (kind == "assistant" || kind == "user")
                    .then(|| item.get("text")?.as_str())
                    .flatten()
                    .filter(|text| !text.trim().is_empty())
            })
            .map(|text| clip_head(text.trim(), 120))
            .unwrap_or_default()
    }

    pub fn metadata(&self, running: bool) -> Value {
        let data = &self.data;
        json!({
            "id": data.id,
            "provider": data.provider,
            "projectId": data.project.id,
            "projectName": data.project.name,
            "projectKind": data.project.kind,
            "projectHost": data.project.host,
            "title": data.title,
            "titleManual": data.title_manual,
            "status": self.status,
            "error": self.error,
            "running": running,
            "safety": data.safety,
            "model": data.model,
            "effort": data.effort,
            "mode": data.mode,
            "createdAt": data.created_at,
            "updatedAt": data.updated_at,
            "rev": data.rev,
            "pending": self.pending_approvals(),
            "preview": self.preview(),
            "usage": data.usage,
            "options": self.options,
        })
    }

    /// `from` 之后变化的条目；`from == 0` 或超前时返回最近的完整窗口。
    pub fn changes(&self, from: u64) -> (bool, Vec<Value>) {
        let full = from == 0 || from > self.data.rev;
        if full {
            let start = self.data.items.len().saturating_sub(SYNC_ITEMS);
            return (true, self.data.items[start..].to_vec());
        }
        let items = self
            .data
            .items
            .iter()
            .filter(|item| item.get("rev").and_then(Value::as_u64).unwrap_or(0) > from)
            .cloned()
            .collect();
        (false, items)
    }

    /// `before` 之前更早的条目（按位置分页）。
    pub fn history(&self, before: &str, limit: usize) -> Vec<Value> {
        let end = self.index.get(before).copied().unwrap_or(0);
        let start = end.saturating_sub(limit);
        self.data.items[start..end].to_vec()
    }
}

/// 截取末尾，保持 UTF-8 字符边界。
pub fn clip_tail(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

/// 截取开头，保持字符边界。
pub fn clip_head(text: &str, chars: usize) -> String {
    let mut iter = text.chars();
    let head: String = iter.by_ref().take(chars).collect();
    if iter.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
pub mod tests_support {
    use super::*;

    pub fn sample(provider: Provider) -> Thread {
        Thread::new(
            ThreadData {
                id: "t1".into(),
                provider,
                project: AgentProject {
                    id: "p1".into(),
                    name: "demo".into(),
                    path: "D:\\demo".into(),
                    kind: "local".into(),
                    host: "Windows".into(),
                },
                title: String::new(),
                title_manual: false,
                created_at: 1,
                updated_at: 1,
                safety: "default".into(),
                model: None,
                effort: None,
                mode: None,
                session: None,
                usage: Value::Null,
                items: Vec::new(),
                rev: 0,
            },
            Status::Idle,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::sample;
    use super::*;

    #[test]
    fn changes_return_only_items_modified_after_the_cursor() {
        let mut thread = sample(Provider::Codex);
        thread.upsert("a", "assistant", |item| {
            item.insert("text".into(), json!("hi"));
        });
        let cursor = thread.data.rev;
        thread.upsert("b", "user", |_| {});
        thread.append_text("a", "assistant", " there");
        let (full, items) = thread.changes(cursor);
        assert!(!full);
        let ids: Vec<_> = items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(thread.item("a").unwrap()["text"], "hi there");
        let (full, items) = thread.changes(0);
        assert!(full);
        assert_eq!(items.len(), 2);
        assert!(thread.changes(thread.data.rev + 5).0);
    }

    #[test]
    fn settle_expires_pending_approvals_and_stops_running_tools() {
        let mut thread = sample(Provider::Claude);
        thread.upsert("q", "approval", |item| {
            item.insert("approval".into(), json!({ "state": "pending" }));
        });
        thread.upsert("t", "tool", |item| {
            item.insert("tool".into(), json!({ "status": "running" }));
        });
        assert_eq!(thread.pending_approvals(), 1);
        thread.settle("expired");
        assert_eq!(thread.pending_approvals(), 0);
        assert_eq!(thread.item("q").unwrap()["approval"]["state"], "expired");
        assert_eq!(thread.item("t").unwrap()["tool"]["status"], "stopped");
    }

    #[test]
    fn prune_keeps_the_newest_items_and_a_valid_index() {
        let mut thread = sample(Provider::Opencode);
        for index in 0..MAX_ITEMS + 10 {
            thread.upsert(&format!("i{index}"), "notice", |_| {});
        }
        assert_eq!(thread.data.items.len(), MAX_ITEMS);
        assert!(!thread.has_item("i0"));
        thread.append_text(&format!("i{}", MAX_ITEMS + 9), "notice", "x");
        assert_eq!(
            thread.item(&format!("i{}", MAX_ITEMS + 9)).unwrap()["text"],
            "x"
        );
    }

    #[test]
    fn clipping_respects_character_boundaries() {
        assert_eq!(clip_tail("你好世界", 6), "…世界");
        assert_eq!(clip_head("你好世界", 2), "你好…");
        assert_eq!(clip_head("短", 5), "短");
    }

    #[test]
    fn title_follows_the_first_non_empty_line_until_renamed() {
        let mut thread = sample(Provider::Codex);
        thread.set_title_from("\n  修复登录问题\n细节");
        assert_eq!(thread.data.title, "修复登录问题");
        thread.set_title_from("另一个");
        assert_eq!(thread.data.title, "修复登录问题");
    }
}
