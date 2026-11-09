//! daemon 的 `git.watchPush` 方法（「Git 多端同步」独立功能）。

use super::*;
use crate::git_push_watch::{self, PushEvent};

pub(super) async fn subscribe(daemon: Arc<Daemon>, conn: ConnCtx, request: Request) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WatchParams {
        root: String,
        #[serde(default)]
        since: Option<i64>,
    }
    let id = request.id;
    let Ok(params) = params::<WatchParams>(&request) else {
        conn.fail(id, "badRequest", "git.watchPush 需要 root");
        return;
    };
    let root = match canonical_root(&params.root) {
        Ok(root) => root,
        Err(message) => {
            conn.fail(id, "outsideRoot", message);
            return;
        }
    };

    let cancel = conn.cancel_flag(id);
    let (tx, mut rx) = mpsc::channel::<PushEvent>(16);
    let cancel_for_task = Arc::clone(&cancel);
    let since = params.since;
    let watcher = tokio::task::spawn_blocking(move || {
        git_push_watch::watch_pushes(&root, since, &cancel_for_task, |event| {
            tx.blocking_send(event).is_ok()
        })
    });
    // `now` 使用本机时钟，客户端重连时原样作为 since，不受两端时钟差影响。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    conn.respond(id, json!({ "subscribed": true, "now": now }));

    while let Some(push) = rx.recv().await {
        let Ok(payload) = encode(&Event::GitPush(push)) else {
            continue;
        };
        if !conn
            .send_async(Priority::Rpc, Frame::new(Kind::Event, id, payload))
            .await
        {
            cancel.store(true, Ordering::SeqCst);
            break;
        }
    }
    drop(rx);
    let error = match watcher.await {
        Ok(Err(message)) => Some(message),
        _ => None,
    };
    conn.stream_end(
        Priority::Rpc,
        id,
        StreamEnd {
            ok: error.is_none(),
            summary: json!({}),
            error,
        },
    );
    conn.clear_cancel(id);
    daemon
        .log
        .info(&format!("连接 {} 的推送监听 {id} 结束", conn.conn_id));
}
