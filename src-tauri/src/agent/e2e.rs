//! 真实 Agent 端到端测试，默认忽略，需要本机已安装并登录对应 CLI：
//!
//! ```text
//! cargo test --lib agent::e2e -- --ignored --nocapture --test-threads=1
//! ```
//!
//! OpenCode 用例会发送真实消息（消耗所选模型额度）；Codex / Claude 用例只做握手和读取额度。
use std::time::{Duration, Instant};

use serde_json::Value;

use super::thread::Status;
use super::{AgentHost, AgentProject, Provider};

fn project() -> (tempfile_dir::Dir, AgentProject) {
    let dir = tempfile_dir::Dir::new();
    std::fs::write(dir.path().join("README.md"), "# e2e\n").unwrap();
    let project = AgentProject {
        id: "e2e".into(),
        name: "e2e".into(),
        path: dir.path().to_string_lossy().into_owned(),
        kind: "local".into(),
        host: "Windows".into(),
    };
    (dir, project)
}

/// 不引入依赖的临时目录。
mod tempfile_dir {
    pub struct Dir(std::path::PathBuf);
    impl Dir {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "qingcode-agent-e2e-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn snapshot(host: &AgentHost, id: &str) -> (Status, Vec<Value>, Value) {
    let slot = host.slot(id).unwrap();
    let core = slot.core.lock().unwrap();
    (
        core.thread.status,
        core.thread.data.items.clone(),
        core.thread.metadata(core.runtime.is_some()),
    )
}

/// 等待条件成立；超时则打印当前条目便于排查。
fn wait(
    host: &AgentHost,
    id: &str,
    timeout: Duration,
    what: &str,
    done: impl Fn(Status, &[Value]) -> bool,
) {
    let deadline = Instant::now() + timeout;
    loop {
        let (status, items, meta) = snapshot(host, id);
        if done(status, &items) {
            return;
        }
        if Instant::now() > deadline {
            panic!(
                "等待「{what}」超时：status={status:?} meta={meta}\nitems={}",
                serde_json::to_string_pretty(&items).unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn idle(status: Status) -> bool {
    status == Status::Idle
}

fn assistant_text(items: &[Value]) -> String {
    items
        .iter()
        .filter(|item| item["kind"] == "assistant")
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn pending_approval(items: &[Value]) -> Option<Value> {
    items
        .iter()
        .find(|item| item["kind"] == "approval" && item["approval"]["state"] == "pending")
        .cloned()
}

fn print_items(label: &str, items: &[Value]) {
    println!("---- {label} ----");
    for item in items {
        let kind = item["kind"].as_str().unwrap_or_default();
        let summary = match kind {
            "tool" => format!(
                "{} {} [{}] {}",
                item["tool"]["category"].as_str().unwrap_or_default(),
                item["tool"]["title"].as_str().unwrap_or_default(),
                item["tool"]["status"].as_str().unwrap_or_default(),
                super::thread::clip_head(
                    item["tool"]["output"].as_str().unwrap_or_default().trim(),
                    80
                ),
            ),
            "approval" => format!(
                "{} {} [{}] choice={}",
                item["approval"]["type"].as_str().unwrap_or_default(),
                item["approval"]["title"].as_str().unwrap_or_default(),
                item["approval"]["state"].as_str().unwrap_or_default(),
                item["approval"]["choice"].as_str().unwrap_or_default(),
            ),
            _ => super::thread::clip_head(item["text"].as_str().unwrap_or_default().trim(), 120),
        };
        println!("{kind:>9} | {summary}");
    }
}

#[test]
#[ignore = "需要本机已配置的 opencode，并发送真实消息"]
fn opencode_real_conversation_approvals_full_access_and_resume() {
    let host = AgentHost::in_memory();
    let (_dir, project) = project();
    let meta = host
        .create(project, Provider::Opencode, Some("ask".into()), None)
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    wait(
        &host,
        &id,
        Duration::from_secs(90),
        "OpenCode 握手",
        |status, _| idle(status),
    );
    let (_, _, meta) = snapshot(&host, &id);
    println!(
        "model={} options.models={}",
        meta["model"],
        meta["options"]["models"].as_array().map_or(0, Vec::len)
    );
    assert!(meta["options"]["models"]
        .as_array()
        .is_some_and(|models| !models.is_empty()));

    // 1. 普通对话：流式回复归并为助手条目。
    host.send(&id, "请只回复这四个字：联调成功", &[], None)
        .unwrap();
    wait(
        &host,
        &id,
        Duration::from_secs(180),
        "第一轮回复",
        |status, items| idle(status) && !assistant_text(items).is_empty(),
    );
    let (_, items, _) = snapshot(&host, &id);
    print_items("第一轮", &items);
    assert!(
        assistant_text(&items).contains("联调成功"),
        "回复：{}",
        assistant_text(&items)
    );

    // 2. 每次询问：运行命令前在“手机”上审批。
    host.send(
        &id,
        "请用 shell 工具运行命令 `echo qingcode-e2e-ask`，然后告诉我命令输出。",
        &[],
        None,
    )
    .unwrap();
    wait(
        &host,
        &id,
        Duration::from_secs(180),
        "命令审批请求",
        |_, items| pending_approval(items).is_some(),
    );
    let (status, items, meta) = snapshot(&host, &id);
    assert_eq!(meta["pending"], 1);
    assert_eq!(status, Status::Running);
    let approval = pending_approval(&items).unwrap();
    print_items("审批前", &items);
    let allow = approval["approval"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["label"] == "允许")
        .expect("应提供「允许」")["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        host.send(&id, "插队消息", &[], None).is_err(),
        "审批期间不应接受新消息"
    );
    host.respond(&id, approval["id"].as_str().unwrap(), &allow, &Value::Null)
        .unwrap();
    wait(
        &host,
        &id,
        Duration::from_secs(180),
        "审批后完成",
        |status, _| idle(status),
    );
    let (_, items, _) = snapshot(&host, &id);
    print_items("审批后", &items);
    let ran = items.iter().any(|item| {
        item["kind"] == "tool"
            && item["tool"]["category"] == "command"
            && item["tool"]["output"]
                .as_str()
                .is_some_and(|output| output.contains("qingcode-e2e-ask"))
    });
    assert!(
        ran || assistant_text(&items).contains("qingcode-e2e-ask"),
        "命令应已执行"
    );

    // 3. 完全访问：不再产生审批。
    host.configure(&id, "safety", "full").unwrap();
    let before = snapshot(&host, &id)
        .1
        .iter()
        .filter(|item| item["kind"] == "approval")
        .count();
    host.send(
        &id,
        "请用 shell 工具运行命令 `echo qingcode-e2e-full`，然后告诉我命令输出。",
        &[],
        None,
    )
    .unwrap();
    wait(
        &host,
        &id,
        Duration::from_secs(180),
        "完全访问一轮",
        |status, items| idle(status) && assistant_text(items).contains("qingcode-e2e-full"),
    );
    let (_, items, meta) = snapshot(&host, &id);
    print_items("完全访问", &items);
    assert_eq!(
        items
            .iter()
            .filter(|item| item["kind"] == "approval")
            .count(),
        before,
        "完全访问不应再请求审批"
    );
    println!("usage={}", meta["usage"]);

    // 4. 结束进程后再次发送：恢复同一 OpenCode 会话，上下文仍在。
    host.close(&id).unwrap();
    assert_eq!(snapshot(&host, &id).0, Status::Closed);
    host.send(
        &id,
        "我前面让你运行的第一条 echo 命令输出的字符串是什么？只回复那个字符串。",
        &[],
        None,
    )
    .unwrap();
    wait(
        &host,
        &id,
        Duration::from_secs(180),
        "恢复会话后回复",
        |status, items| {
            idle(status) && assistant_text(items).matches("qingcode-e2e-ask").count() >= 2
        },
    );
    let (_, items, _) = snapshot(&host, &id);
    print_items("恢复会话", &items);
    host.delete(&id).unwrap();
}

#[test]
#[ignore = "需要本机已安装的 codex；只握手，不发送消息"]
fn codex_real_handshake_lists_models() {
    let host = AgentHost::in_memory();
    let (_dir, project) = project();
    let meta = host
        .create(project, Provider::Codex, Some("read-only".into()), None)
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    wait(
        &host,
        &id,
        Duration::from_secs(60),
        "Codex 握手",
        |status, _| idle(status),
    );
    let (_, _, meta) = snapshot(&host, &id);
    println!(
        "codex session={} model={} models={}",
        meta["id"],
        meta["model"],
        meta["options"]["models"].as_array().map_or(0, Vec::len)
    );
    assert!(host
        .slot(&id)
        .unwrap()
        .core
        .lock()
        .unwrap()
        .thread
        .data
        .session
        .is_some());
    let usage = host.usage(false);
    println!("codex quota={}", usage[1]);
    host.delete(&id).unwrap();
}

#[test]
#[ignore = "需要本机已登录的 claude；只握手与读取额度，不发送消息"]
fn claude_real_handshake_and_usage() {
    let host = AgentHost::in_memory();
    let (_dir, project) = project();
    let meta = host
        .create(project, Provider::Claude, Some("default".into()), None)
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    wait(
        &host,
        &id,
        Duration::from_secs(60),
        "Claude 握手",
        |status, _| idle(status),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let quota = loop {
        let usage = host.usage(false);
        if usage[0].get("windows").is_some() || Instant::now() > deadline {
            break usage[0].clone();
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    let (_, _, meta) = snapshot(&host, &id);
    println!(
        "claude models={} quota={quota}",
        meta["options"]["models"].as_array().map_or(0, Vec::len)
    );
    assert!(quota["windows"].is_array(), "应读取到额度：{quota}");
    host.delete(&id).unwrap();
}
