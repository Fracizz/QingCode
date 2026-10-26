//! 真机 Server 模式稳定性 / 并发 / 功能 / 效率验收。
//!
//! 直接复用产品的发现部署、daemon 会话、终端共享连接池与输入发送路径，
//! 只把前端事件换成本地统计，用来在真实远端上暴露长连接掉线、输出丢序、
//! 多连接并发互相阻塞等问题。只在显式设置环境变量并加 `--ignored` 时运行：
//!
//! ```text
//! QC_STAB_HOST / QC_STAB_USER / QC_STAB_PASSWORD / QC_STAB_PORT(默认 22)
//! QC_STAB_ROOT        远端项目根（Linux 如 /root/qc-stab；Windows 如 /C:/Users/Administrator/qc-stab）
//! QC_STAB_SERVER_DIR  本地 server 二进制目录（src-tauri/target/server）
//! QC_STAB_LONG_SECS   长连接阶段时长（默认 300）
//! QC_STAB_CONNS       并发连接数（默认 3）
//! QC_STAB_TERMS       每个连接的并发终端数（默认 8）
//! QC_STAB_PHASES      逗号分隔的阶段子集（默认全部：func,flood,reattach,long,multi）
//! cargo test --lib real_host_stability -- --ignored --nocapture
//! ```

use super::*;
use crate::remote_ssh::{
    ssh_probe_host, store_authenticated_session, RemoteMode, SshConnectionConfig,
};

const TAIL_LIMIT: usize = 256 * 1024;

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn env_num(name: &str, default: u64) -> u64 {
    env(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn ms(duration: Duration) -> String {
    format!("{:.0}ms", duration.as_secs_f64() * 1000.0)
}

/// 去掉 CSI / OSC 等控制序列，ConPTY 会在行内插入光标定位。
fn strip_ansi(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            if ch != '\r' && ch != '\n' {
                out.push(ch);
            } else {
                out.push('\n');
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[derive(Default, Clone)]
struct Stats {
    samples: Vec<Duration>,
}

impl Stats {
    fn push(&mut self, sample: Duration) {
        self.samples.push(sample);
    }

    fn merge(&mut self, other: &Stats) {
        self.samples.extend_from_slice(&other.samples);
    }

    fn summary(&self) -> String {
        if self.samples.is_empty() {
            return "无样本".to_string();
        }
        let mut sorted = self.samples.clone();
        sorted.sort();
        let pick = |q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
        format!(
            "n={} p50={} p95={} max={}",
            sorted.len(),
            ms(pick(0.5)),
            ms(pick(0.95)),
            ms(*sorted.last().unwrap())
        )
    }
}

/// 一台远端上的测试上下文：一个 SshManager 对应一个「客户端连接」。
struct Ctx {
    manager: SshManager,
    connection_id: String,
    root: RegisteredRoot,
    daemon: DaemonAccess,
    windows: bool,
}

/// 一个直接挂在 daemon 会话上的终端，统计输出序号连续性与到达间隔。
struct Term {
    transport: TerminalTransportLease,
    session: DaemonSession,
    events: mpsc::UnboundedReceiver<Event>,
    pty_id: String,
    next_seq: u64,
    input_seq: AtomicU64,
    tail: Vec<u8>,
    total_bytes: u64,
    seq_gaps: u32,
    last_data: Instant,
    max_data_gap: Duration,
    exit_code: Option<Option<i32>>,
    probe_counter: u64,
}

impl Term {
    async fn open(ctx: &Ctx, cols: u16, rows: u16) -> Result<Self, String> {
        let client_id = ctx.manager.daemon_client_id(&ctx.connection_id);
        let (transport, mut session) = open_terminal_daemon_session(
            &ctx.manager,
            &ctx.connection_id,
            &ctx.root.uri,
            &client_id,
            &ctx.daemon,
        )
        .await?;
        let response = match session
            .request(
                "pty.create",
                &serde_json::json!({
                    "cwd": ctx.root.canonical_path,
                    "cols": cols,
                    "rows": rows,
                    "name": "qc-stab",
                }),
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                session.shutdown();
                transport.release();
                return Err(error);
            }
        };
        let pty_id = response
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or("pty.create 应答缺少 id")?
            .to_string();
        let seq = response
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let events = session.take_events().ok_or("事件流已被取走")?;
        Ok(Self {
            transport,
            session,
            events,
            pty_id,
            next_seq: seq,
            input_seq: AtomicU64::new(0),
            tail: Vec::new(),
            total_bytes: 0,
            seq_gaps: 0,
            last_data: Instant::now(),
            max_data_gap: Duration::ZERO,
            exit_code: None,
            probe_counter: 0,
        })
    }

    fn on_event(&mut self, event: Event) {
        match event {
            Event::PtyData { id, seq, data, .. } if id == self.pty_id => {
                if seq > self.next_seq {
                    self.seq_gaps += 1;
                    println!(
                        "[stab][WARN] pty {} 输出序号不连续：期望 {} 收到 {seq}",
                        self.pty_id, self.next_seq
                    );
                }
                if seq >= self.next_seq {
                    let now = Instant::now();
                    self.max_data_gap = self.max_data_gap.max(now - self.last_data);
                    self.last_data = now;
                    self.total_bytes += data.len() as u64;
                    self.tail.extend_from_slice(&data);
                    if self.tail.len() > TAIL_LIMIT {
                        let cut = self.tail.len() - TAIL_LIMIT;
                        self.tail.drain(..cut);
                    }
                    self.next_seq = seq + 1;
                }
            }
            Event::PtyExit { id, code } if id == self.pty_id => self.exit_code = Some(code),
            _ => {}
        }
    }

    /// 处理到期限为止的事件；会话断开时报错。
    async fn pump_until(&mut self, deadline: Instant) -> Result<(), String> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            match tokio::time::timeout(remaining, self.events.recv()).await {
                Ok(Some(event)) => self.on_event(event),
                Ok(None) => {
                    return Err(format!(
                        "会话断开：{}",
                        self.session.closed_reason().unwrap_or_default()
                    ))
                }
                Err(_) => return Ok(()),
            }
        }
    }

    async fn send(&self, text: &str) -> Result<(), String> {
        send_input_to_session(
            &self.session,
            &self.pty_id,
            &self.input_seq,
            text.as_bytes().to_vec(),
        )
        .await
        .map_err(|(error, _)| error)
    }

    /// 等输出里出现 `marker`（只看本次等待开始后的新输出）。
    async fn wait_for(&mut self, marker: &str, timeout: Duration) -> Result<Duration, String> {
        let started = Instant::now();
        let deadline = started + timeout;
        self.tail.clear();
        // 只重扫新到的数据（带 4KB 回看覆盖跨块的标记与控制序列），
        // 避免大输出时每个事件都全量剥离尾部，把测试端变成瓶颈。
        let mut scanned_total = self.total_bytes;
        loop {
            let fresh = (self.total_bytes - scanned_total) as usize;
            let from = self.tail.len().saturating_sub(fresh + 4096);
            if strip_ansi(&self.tail[from..]).contains(marker) {
                return Ok(started.elapsed());
            }
            scanned_total = self.total_bytes;
            if let Some(code) = self.exit_code {
                return Err(format!("等待 {marker} 时 PTY 已退出（{code:?}）"));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let seen = strip_ansi(&self.tail);
                let seen: String = seen
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                return Err(format!("等待 {marker} 超时，最近输出：{seen:?}"));
            }
            match tokio::time::timeout(remaining, self.events.recv()).await {
                Ok(Some(event)) => self.on_event(event),
                Ok(None) => {
                    return Err(format!(
                        "等待 {marker} 时会话断开：{}",
                        self.session.closed_reason().unwrap_or_default()
                    ))
                }
                Err(_) => {}
            }
        }
    }

    /// 输入一条计算型 echo，测量「按回车 → 结果回显」往返。
    async fn echo_probe(&mut self, windows: bool, tag: &str) -> Result<Duration, String> {
        self.probe_counter += 1;
        let n = self.probe_counter * 1000 + (std::process::id() as u64 % 997);
        let marker = format!("QC{tag}_{}_END", n + 1);
        let command = if windows {
            format!("Write-Output ('QC{tag}_' + ({n}+1) + '_END')\r")
        } else {
            format!("echo QC{tag}_$(({n}+1))_END\r")
        };
        let started = Instant::now();
        self.send(&command).await?;
        self.wait_for(&marker, Duration::from_secs(30)).await?;
        Ok(started.elapsed())
    }

    /// 与产品会话循环一致的心跳：发 ping，记录最久未收帧时长。
    fn heartbeat(&self) -> Duration {
        let age = self.session.last_frame_age();
        self.session.send_ping();
        age
    }

    async fn kill(self) {
        let _ = self
            .session
            .request("pty.kill", &serde_json::json!({ "id": self.pty_id }))
            .await;
        self.session.shutdown();
        self.transport.release();
    }

    fn detach(self) -> (String, u64) {
        self.session.shutdown();
        self.transport.release();
        (self.pty_id, self.next_seq)
    }
}

async fn connect(
    host: &str,
    connection_id: &str,
    server_dir: &str,
    root_path: &str,
) -> Result<Ctx, String> {
    let config = SshConnectionConfig {
        id: connection_id.to_string(),
        host: host.to_string(),
        port: env_num("QC_STAB_PORT", 22) as u16,
        username: env("QC_STAB_USER").unwrap_or_else(|| "root".to_string()),
        auth_kind: "password".to_string(),
        password: env("QC_STAB_PASSWORD"),
        private_key_path: None,
        passphrase: None,
        host_key_fingerprint: None,
        mode: Some(RemoteMode::Server),
    };
    let manager = SshManager::new();
    manager.set_client_id(format!("qc-stab-{}", std::process::id()));
    manager.set_server_binary_dirs(vec![PathBuf::from(server_dir)]);
    let mut config = config;
    config.host_key_fingerprint = Some(ssh_probe_host(config.clone()).await?.fingerprint);
    store_authenticated_session(&manager, config).await?;

    let sftp = manager.open_sftp(connection_id).await?;
    if let Err(error) = sftp.create_dir(root_path.to_string()).await {
        println!("[stab] 创建项目根 {root_path}：{error}");
    }
    let canonical_path = sftp
        .canonicalize(root_path.to_string())
        .await
        .map_err(|error| format!("项目根不可用：{error}"))?;
    let uri = format!("ssh://{connection_id}{root_path}");
    let root = RegisteredRoot {
        uri: normalize_remote_uri(&uri),
        canonical_path: canonical_path.clone(),
        trusted: true,
    };
    manager
        .roots
        .write()
        .map_err(|_| "工作区状态不可用")?
        .insert(root.uri.clone(), root.clone());
    let windows = windows_native_path(&canonical_path).is_some();

    // 发现 / 部署，再等后台 daemon 探测完成。
    let started = Instant::now();
    let key = server_slot_key(connection_id, &canonical_path);
    let mut daemon = None;
    while started.elapsed() < Duration::from_secs(120) {
        let round = Instant::now();
        let ensured = ensure_server_endpoint_with_app(&manager, &root, None).await?;
        let slot = manager.server_slot(&key).unwrap_or_default();
        println!(
            "[stab] {connection_id} ensure 一轮 {}：端点={} daemon={} 不可用={:?} 失败={:?} daemon失败={:?} 降级={:?} 分段=[{}]",
            ms(round.elapsed()),
            ensured.is_some(),
            ensured.as_ref().is_some_and(|endpoint| endpoint.daemon.is_some()),
            slot.unavailable_reason,
            slot.last_failure,
            slot.daemon_failure,
            slot.daemon_downgraded_at.map(|at| at.elapsed()),
            slot.last_timings.clone().unwrap_or_default()
        );
        if let Some(endpoint) = ensured {
            if let Some(access) = endpoint.daemon {
                daemon = Some(access);
                break;
            }
        }
        if let Some(access) = manager
            .server_slot(&key)
            .and_then(|slot| slot.endpoint)
            .and_then(|endpoint| endpoint.daemon)
        {
            daemon = Some(access);
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let slot = manager.server_slot(&key).unwrap_or_default();
    let daemon = daemon.ok_or_else(|| {
        format!(
            "daemon 未就绪：失败={:?} daemon失败={:?}",
            slot.last_failure, slot.daemon_failure
        )
    })?;
    println!(
        "[stab] {connection_id} daemon 就绪 {}（分段 {}）",
        ms(started.elapsed()),
        slot.last_timings.unwrap_or_default()
    );
    Ok(Ctx {
        manager,
        connection_id: connection_id.to_string(),
        root,
        daemon,
        windows,
    })
}

async fn remote_exec(ctx: &Ctx, unix: &str, windows: &str) -> Result<String, String> {
    let result = ctx
        .manager
        .exec_remote_shell(&ctx.root.uri, unix, windows, true, Duration::from_secs(120))
        .await?;
    Ok(format!("{}{}", result.stdout, result.stderr))
}

/// 功能：回显、resize、pty.list、退出码。
async fn phase_func(ctx: &Ctx, failures: &mut Vec<String>) -> Result<(), String> {
    let started = Instant::now();
    let mut term = Term::open(ctx, 100, 30).await?;
    println!("[stab][func] 打开终端 {}", ms(started.elapsed()));
    term.pump_until(Instant::now() + Duration::from_secs(2))
        .await?;
    let mut stats = Stats::default();
    for _ in 0..10 {
        stats.push(term.echo_probe(ctx.windows, "F").await?);
    }
    println!("[stab][func] 回显往返 {}", stats.summary());

    resize_session(&term.session, &term.pty_id, 120, 40).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let size_cmd = if ctx.windows {
        "Write-Output ('QCS_' + $Host.UI.RawUI.WindowSize.Height + 'x' + $Host.UI.RawUI.WindowSize.Width + '_END')\r"
    } else {
        "echo QCS_$(stty size | tr ' ' x)_END\r"
    };
    term.send(size_cmd).await?;
    match term
        .wait_for("QCS_40x120_END", Duration::from_secs(15))
        .await
    {
        Ok(_) => println!("[stab][func] resize 120x40 生效"),
        Err(error) => failures.push(format!("func/resize：{error}")),
    }

    let listed = term
        .session
        .request("pty.list", &serde_json::json!({}))
        .await?;
    if !listed.to_string().contains(&term.pty_id) {
        failures.push(format!("func/pty.list 未包含 {}：{listed}", term.pty_id));
    }

    term.send("exit 3\r").await?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while term.exit_code.is_none() && Instant::now() < deadline {
        term.pump_until(Instant::now().min(deadline) + Duration::from_millis(200))
            .await?;
    }
    match term.exit_code {
        Some(Some(3)) => println!("[stab][func] exit 3 → 退出码 3"),
        other => failures.push(format!("func/exit：期望退出码 3，实际 {other:?}")),
    }
    if term.seq_gaps > 0 {
        failures.push(format!("func：输出序号缺口 {}", term.seq_gaps));
    }
    term.kill().await;
    Ok(())
}

/// 大输出：一个终端刷屏的同时，另一个终端测回显延迟（共享连接公平性）。
async fn phase_flood(ctx: &Ctx, failures: &mut Vec<String>) -> Result<(), String> {
    let mut flood = Term::open(ctx, 120, 40).await?;
    let mut probe = Term::open(ctx, 120, 40).await?;
    flood
        .pump_until(Instant::now() + Duration::from_secs(2))
        .await?;
    probe
        .pump_until(Instant::now() + Duration::from_secs(1))
        .await?;
    let (command, marker) = if ctx.windows {
        (
            "1..60000 | % { \"L$_\" }; Write-Output ('QCFLOOD_' + (1+1) + '_END')\r",
            "QCFLOOD_2_END",
        )
    } else {
        ("seq 1 600000; echo QCFLOOD_$((1+1))_END\r", "QCFLOOD_2_END")
    };
    let started = Instant::now();
    let bytes_before = flood.total_bytes;
    flood.send(command).await?;
    let mut probe_stats = Stats::default();
    let flood_task = async {
        let result = flood.wait_for(marker, Duration::from_secs(240)).await;
        (result, flood)
    };
    let probe_task = async {
        let mut errors = Vec::new();
        let until = Instant::now() + Duration::from_secs(8);
        while Instant::now() < until {
            match probe.echo_probe(ctx.windows, "P").await {
                Ok(latency) => probe_stats.push(latency),
                Err(error) => {
                    errors.push(error);
                    break;
                }
            }
        }
        (errors, probe)
    };
    let ((result, flood), (probe_errors, probe)) = tokio::join!(flood_task, probe_task);
    let elapsed = started.elapsed();
    let bytes = flood.total_bytes - bytes_before;
    match result {
        Ok(_) => println!(
            "[stab][flood] {:.1} MiB 用时 {:.2}s（{:.1} MiB/s），序号缺口 {}，刷屏期间另一终端回显 {}",
            bytes as f64 / 1048576.0,
            elapsed.as_secs_f64(),
            bytes as f64 / 1048576.0 / elapsed.as_secs_f64().max(0.001),
            flood.seq_gaps,
            probe_stats.summary()
        ),
        Err(error) => failures.push(format!("flood：{error}")),
    }
    if flood.seq_gaps > 0 {
        failures.push(format!("flood：输出序号缺口 {}", flood.seq_gaps));
    }
    for error in probe_errors {
        failures.push(format!("flood/并行回显：{error}"));
    }
    flood.kill().await;
    probe.kill().await;
    Ok(())
}

/// 断开重连：终端持续输出时断开 daemon 会话与共享连接，重连后按 seq 续接。
async fn phase_reattach(ctx: &Ctx, failures: &mut Vec<String>) -> Result<(), String> {
    let mut term = Term::open(ctx, 100, 30).await?;
    term.pump_until(Instant::now() + Duration::from_secs(2))
        .await?;
    let ticker = if ctx.windows {
        "while($true){ 'TICK' + [DateTime]::Now.Ticks; Start-Sleep -Milliseconds 200 }\r"
    } else {
        "while :; do echo TICK$(date +%s%N); sleep 0.2; done\r"
    };
    term.send(ticker).await?;
    term.pump_until(Instant::now() + Duration::from_secs(3))
        .await?;
    let (pty_id, next_seq) = term.detach();
    println!("[stab][reattach] 已断开（pty {pty_id} 下一 seq {next_seq}），5s 后重连");
    tokio::time::sleep(Duration::from_secs(5)).await;

    let started = Instant::now();
    let client_id = ctx.manager.daemon_client_id(&ctx.connection_id);
    let (transport, mut session) = open_terminal_daemon_session(
        &ctx.manager,
        &ctx.connection_id,
        &ctx.root.uri,
        &client_id,
        &ctx.daemon,
    )
    .await?;
    let attach = session.attach(&pty_id, next_seq).await?;
    let first_seq = attach.chunks.first().and_then(|chunk| chunk.seq);
    let replay_bytes: usize = attach.chunks.iter().map(|chunk| chunk.data.len()).sum();
    let replay_text = strip_ansi(
        &attach
            .chunks
            .iter()
            .flat_map(|chunk| chunk.data.iter().copied())
            .collect::<Vec<_>>(),
    );
    println!(
        "[stab][reattach] 接回 {}：补发 {} 块 {replay_bytes} 字节，首块 seq {first_seq:?}，end={:?}",
        ms(started.elapsed()),
        attach.chunks.len(),
        attach.stream_end
    );
    if first_seq.is_some_and(|seq| seq != next_seq) {
        failures.push(format!(
            "reattach：补发首块 seq {first_seq:?} 与断开时的下一 seq {next_seq} 不一致"
        ));
    }
    let ticks = replay_text.matches("TICK").count();
    if ticks < 15 {
        failures.push(format!(
            "reattach：断开 5s 期间只补发了 {ticks} 个 TICK（期望约 25）"
        ));
    }
    let resume_seq = attach
        .chunks
        .last()
        .and_then(|chunk| chunk.seq.map(|seq| seq + 1))
        .unwrap_or(next_seq);
    let events = session.take_events().ok_or("事件流已被取走")?;
    let mut term = Term {
        transport,
        session,
        events,
        pty_id,
        next_seq: resume_seq,
        input_seq: AtomicU64::new(
            attach
                .response
                .get("nextInputSeq")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        ),
        tail: Vec::new(),
        total_bytes: 0,
        seq_gaps: 0,
        last_data: Instant::now(),
        max_data_gap: Duration::ZERO,
        exit_code: None,
        probe_counter: 0,
    };
    term.pump_until(Instant::now() + Duration::from_secs(3))
        .await?;
    let live = strip_ansi(&term.tail).matches("TICK").count();
    if live < 8 || term.seq_gaps > 0 {
        failures.push(format!(
            "reattach：接回后 3s 收到 {live} 个 TICK，序号缺口 {}",
            term.seq_gaps
        ));
    } else {
        println!("[stab][reattach] 接回后实时输出正常（3s 收到 {live} 个 TICK）");
    }
    term.send("\u{3}").await?;
    match term.echo_probe(ctx.windows, "R").await {
        Ok(latency) => println!("[stab][reattach] Ctrl+C 后输入可用，回显 {}", ms(latency)),
        Err(error) => failures.push(format!("reattach/接回后输入：{error}")),
    }
    term.kill().await;
    Ok(())
}

/// 长连接：opencode（若有）/ 持续输出 / 空闲 shell 三个终端同时保持，
/// 期间按产品节奏心跳并定期测回显，统计掉线、序号缺口与输出停顿。
async fn phase_long(ctx: &Ctx, failures: &mut Vec<String>) -> Result<(), String> {
    let duration = Duration::from_secs(env_num("QC_STAB_LONG_SECS", 300));
    let opencode = remote_exec(
        ctx,
        "command -v opencode || ls ~/.opencode/bin/opencode 2>/dev/null",
        "(Get-Command opencode -ErrorAction SilentlyContinue).Source",
    )
    .await
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .find(|line| !line.is_empty())
    .map(str::to_string);
    println!(
        "[stab][long] 时长 {}s，opencode={opencode:?}",
        duration.as_secs()
    );

    let mut tui = Term::open(ctx, 140, 40).await?;
    let mut ticker = Term::open(ctx, 100, 30).await?;
    let mut idle = Term::open(ctx, 100, 30).await?;
    for term in [&mut tui, &mut ticker, &mut idle] {
        term.pump_until(Instant::now() + Duration::from_secs(2))
            .await?;
    }
    let tui_command = match (&opencode, ctx.windows) {
        (Some(path), true) => format!("& '{path}'\r"),
        (Some(path), false) => format!("{path}\r"),
        (None, true) => "while($true){ Get-Process | Sort-Object CPU -Desc | Select -First 30 | Format-Table -Auto | Out-String; Start-Sleep 1; Clear-Host }\r".to_string(),
        (None, false) => "top -d 1\r".to_string(),
    };
    tui.send(&tui_command).await?;
    ticker
        .send(if ctx.windows {
            "while($true){ 'TICK' + [DateTime]::Now.Ticks; Start-Sleep -Milliseconds 500 }\r"
        } else {
            "while :; do echo TICK$(date +%s%N); sleep 0.5; done\r"
        })
        .await?;

    let started = Instant::now();
    let mut idle_stats = Stats::default();
    let mut max_frame_age = Duration::ZERO;
    let mut next_report = started + Duration::from_secs(60);
    ticker.max_data_gap = Duration::ZERO;
    ticker.last_data = Instant::now();
    while started.elapsed() < duration {
        // 心跳节奏与产品一致：每 10s 一次；期间持续消费三个终端的事件。
        let window_end = Instant::now() + Duration::from_secs(10);
        let (a, b, c) = tokio::join!(
            tui.pump_until(window_end),
            ticker.pump_until(window_end),
            idle.pump_until(window_end)
        );
        for (name, result) in [("tui", a), ("ticker", b), ("idle", c)] {
            if let Err(error) = result {
                failures.push(format!(
                    "long/{name} 在 {}s 时断开：{error}",
                    started.elapsed().as_secs()
                ));
                return Ok(());
            }
        }
        for term in [&tui, &ticker, &idle] {
            max_frame_age = max_frame_age.max(term.heartbeat());
        }
        match idle.echo_probe(ctx.windows, "L").await {
            Ok(latency) => idle_stats.push(latency),
            Err(error) => {
                failures.push(format!(
                    "long/idle 回显在 {}s 时失败：{error}",
                    started.elapsed().as_secs()
                ));
                return Ok(());
            }
        }
        if Instant::now() >= next_report {
            next_report += Duration::from_secs(60);
            println!(
                "[stab][long] {}s：tui {} KiB，ticker 最大停顿 {}，最久未收帧 {}，空闲回显 {}",
                started.elapsed().as_secs(),
                tui.total_bytes / 1024,
                ms(ticker.max_data_gap),
                ms(max_frame_age),
                idle_stats.summary()
            );
        }
    }
    println!(
        "[stab][long] 完成 {}s：tui 收 {} KiB（退出={:?}），ticker 最大停顿 {}，最久未收帧 {}，序号缺口 tui/ticker/idle={}/{}/{}，空闲回显 {}",
        started.elapsed().as_secs(),
        tui.total_bytes / 1024,
        tui.exit_code,
        ms(ticker.max_data_gap),
        ms(max_frame_age),
        tui.seq_gaps,
        ticker.seq_gaps,
        idle.seq_gaps,
        idle_stats.summary()
    );
    if tui.exit_code.is_some() {
        failures.push(format!("long/tui 进程中途退出：{:?}", tui.exit_code));
    }
    if ticker.max_data_gap > Duration::from_secs(5) {
        failures.push(format!(
            "long/ticker 输出最大停顿 {}",
            ms(ticker.max_data_gap)
        ));
    }
    if max_frame_age >= DAEMON_HEARTBEAT_TIMEOUT {
        failures.push(format!(
            "long：最久未收帧 {} 已达产品掉线阈值",
            ms(max_frame_age)
        ));
    }
    let gaps = tui.seq_gaps + ticker.seq_gaps + idle.seq_gaps;
    if gaps > 0 {
        failures.push(format!("long：输出序号缺口 {gaps}"));
    }
    tui.send("\u{3}\u{3}").await.ok();
    for term in [tui, ticker, idle] {
        term.kill().await;
    }
    Ok(())
}

/// 多连接并发：K 个独立客户端连接同时就绪，各开 T 个终端并行回显，
/// 同时跑目录扫描与内容搜索；最后核对没有遗留 PTY。
async fn phase_multi(
    host: &str,
    server_dir: &str,
    root_path: &str,
    failures: &mut Vec<String>,
) -> Result<(), String> {
    let conns = env_num("QC_STAB_CONNS", 3) as usize;
    let terms = env_num("QC_STAB_TERMS", 8) as usize;
    let started = Instant::now();
    let mut connecting = Vec::new();
    for index in 0..conns {
        let host = host.to_string();
        let server_dir = server_dir.to_string();
        let root_path = root_path.to_string();
        connecting.push(tauri::async_runtime::spawn(async move {
            connect(&host, &format!("stab-m{index}"), &server_dir, &root_path).await
        }));
    }
    let mut ctxs = Vec::new();
    for handle in connecting {
        match handle.await.map_err(|error| error.to_string())? {
            Ok(ctx) => ctxs.push(Arc::new(ctx)),
            Err(error) => failures.push(format!("multi/并发连接就绪失败：{error}")),
        }
    }
    println!(
        "[stab][multi] {} / {conns} 个连接并发就绪 {}",
        ctxs.len(),
        ms(started.elapsed())
    );

    let started = Instant::now();
    let mut tasks = Vec::new();
    for ctx in &ctxs {
        for index in 0..terms {
            let ctx = Arc::clone(ctx);
            tasks.push(tauri::async_runtime::spawn(async move {
                let opened_at = Instant::now();
                let mut term = Term::open(&ctx, 100, 30).await.map_err(|error| {
                    format!("{} 终端#{index} 打开失败：{error}", ctx.connection_id)
                })?;
                let open = opened_at.elapsed();
                term.pump_until(Instant::now() + Duration::from_secs(2))
                    .await?;
                let mut stats = Stats::default();
                for _ in 0..15 {
                    stats.push(
                        term.echo_probe(ctx.windows, "M").await.map_err(|error| {
                            format!("{} 终端#{index}：{error}", ctx.connection_id)
                        })?,
                    );
                }
                let gaps = term.seq_gaps;
                term.kill().await;
                Ok::<_, String>((open, stats, gaps))
            }));
        }
        let ctx = Arc::clone(ctx);
        tasks.push(tauri::async_runtime::spawn(async move {
            let mut stats = Stats::default();
            for _ in 0..5 {
                let at = Instant::now();
                daemon_scan_entries(
                    &ctx.manager,
                    &ctx.connection_id,
                    &ctx.daemon,
                    &ctx.root.canonical_path,
                    "",
                )
                .await
                .map_err(|error| format!("{} fs.scan：{error:?}", ctx.connection_id))?;
                stats.push(at.elapsed());
            }
            Ok((Duration::ZERO, stats, 0))
        }));
    }
    let mut open_stats = Stats::default();
    let mut echo_stats = Stats::default();
    let mut ok = 0usize;
    let total = tasks.len();
    for handle in tasks {
        match handle.await.map_err(|error| error.to_string())? {
            Ok((open, stats, gaps)) => {
                ok += 1;
                if open > Duration::ZERO {
                    open_stats.push(open);
                    echo_stats.merge(&stats);
                } else {
                    println!("[stab][multi] 并发期间 fs.scan {}", stats.summary());
                }
                if gaps > 0 {
                    failures.push(format!("multi：输出序号缺口 {gaps}"));
                }
            }
            Err(error) => failures.push(format!("multi：{error}")),
        }
    }
    println!(
        "[stab][multi] {ok}/{total} 个任务成功，用时 {}；终端打开 {}；回显 {}",
        ms(started.elapsed()),
        open_stats.summary(),
        echo_stats.summary()
    );

    // 收尾核对：本测试客户端不应残留 PTY。
    tokio::time::sleep(Duration::from_secs(1)).await;
    for ctx in &ctxs {
        let client_id = ctx.manager.daemon_client_id(&ctx.connection_id);
        let (transport, session) = open_terminal_daemon_session(
            &ctx.manager,
            &ctx.connection_id,
            &ctx.root.uri,
            &client_id,
            &ctx.daemon,
        )
        .await?;
        let listed = session.request("pty.list", &serde_json::json!({})).await?;
        let leaked = listed
            .get("ptys")
            .and_then(serde_json::Value::as_array)
            .map(|ptys| {
                ptys.iter()
                    .filter(|pty| {
                        pty.get("owner").and_then(serde_json::Value::as_str)
                            == Some(client_id.as_str())
                            && pty.get("exited").is_none_or(serde_json::Value::is_null)
                    })
                    .count()
            })
            .unwrap_or(0);
        if leaked > 0 {
            failures.push(format!("multi：{} 残留 {leaked} 个 PTY", ctx.connection_id));
        }
        session.shutdown();
        transport.release();
    }
    Ok(())
}

async fn seed_project(ctx: &Ctx) -> Result<(), String> {
    let started = Instant::now();
    // exec_remote_shell 在用户 home 执行，必须先进入项目根。
    let unix_root = ctx.root.canonical_path.replace('\'', r"'\''");
    let windows_root = windows_native_path(&ctx.root.canonical_path)
        .unwrap_or_default()
        .replace('\'', "''");
    let output = remote_exec(
        ctx,
        &format!("cd '{unix_root}' && mkdir -p src/a src/b && for i in $(seq 1 600); do echo \"fn main_$i() {{ println!(\\\"qc stab $i\\\"); }}\" > src/a/f$i.rs; cp src/a/f$i.rs src/b/g$i.rs; done; ls src/a | wc -l"),
        &format!("Set-Location -LiteralPath '{windows_root}'; New-Item -ItemType Directory -Force src/a,src/b | Out-Null; 1..600 | % {{ Set-Content -Path \"src/a/f$_.rs\" -Value \"fn main_$_() {{ println!(`\"qc stab $_`\"); }}\"; Copy-Item \"src/a/f$_.rs\" \"src/b/g$_.rs\" }}; (Get-ChildItem src/a).Count"),
    )
    .await?;
    println!(
        "[stab] 准备 1200 个文件 {}：{}",
        ms(started.elapsed()),
        output.trim()
    );
    Ok(())
}

async fn phase_efficiency(ctx: &Ctx) -> Result<(), String> {
    let mut scan = Stats::default();
    for _ in 0..5 {
        let at = Instant::now();
        let entries = daemon_scan_entries(
            &ctx.manager,
            &ctx.connection_id,
            &ctx.daemon,
            &ctx.root.canonical_path,
            "",
        )
        .await
        .map_err(|error| format!("{error:?}"))?;
        scan.push(at.elapsed());
        if entries.is_empty() {
            return Err("fs.scan 返回空".to_string());
        }
    }
    let mut search = Stats::default();
    let mut hits = 0usize;
    for _ in 0..3 {
        let at = Instant::now();
        hits = 0;
        daemon_search_content_call(
            &ctx.manager,
            &ctx.connection_id,
            &ctx.daemon,
            DaemonSearchParams {
                root: ctx.root.canonical_path.clone(),
                query: "qc stab 59".to_string(),
                ignore_case: true,
                include_globs: Vec::new(),
                exclude_globs: Vec::new(),
                no_ignore: false,
                max_matches: 500,
                max_per_file: 20,
                max_files: 2000,
            },
            Instant::now() + Duration::from_secs(30),
            || false,
            |_| {
                hits += 1;
                true
            },
        )
        .await
        .map_err(|error| format!("{error:?}"))?;
        search.push(at.elapsed());
    }
    println!(
        "[stab][eff] fs.scan {}；search.content（{hits} 条记录）{}",
        scan.summary(),
        search.summary()
    );
    Ok(())
}

async fn run() -> Result<Vec<String>, String> {
    let host = env("QC_STAB_HOST").ok_or("缺少 QC_STAB_HOST")?;
    let root_path = env("QC_STAB_ROOT").ok_or("缺少 QC_STAB_ROOT")?;
    let server_dir = env("QC_STAB_SERVER_DIR").ok_or("缺少 QC_STAB_SERVER_DIR")?;
    let phases =
        env("QC_STAB_PHASES").unwrap_or_else(|| "func,flood,reattach,long,multi".to_string());
    let enabled = |name: &str| phases.split(',').any(|phase| phase.trim() == name);
    let mut failures = Vec::new();

    let ctx = connect(&host, "stab-main", &server_dir, &root_path).await?;
    seed_project(&ctx).await?;
    if let Err(error) = phase_efficiency(&ctx).await {
        failures.push(format!("eff：{error}"));
    }
    type Phase = for<'a> fn(
        &'a Ctx,
        &'a mut Vec<String>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>,
    >;
    let phases_list: [(&str, Phase); 4] = [
        ("func", |ctx, failures| Box::pin(phase_func(ctx, failures))),
        ("flood", |ctx, failures| {
            Box::pin(phase_flood(ctx, failures))
        }),
        ("reattach", |ctx, failures| {
            Box::pin(phase_reattach(ctx, failures))
        }),
        ("long", |ctx, failures| Box::pin(phase_long(ctx, failures))),
    ];
    for (name, phase) in phases_list {
        if !enabled(name) {
            continue;
        }
        let started = Instant::now();
        if let Err(error) = phase(&ctx, &mut failures).await {
            failures.push(format!("{name} 中止：{error}"));
        }
        println!("[stab] 阶段 {name} 结束 {}", ms(started.elapsed()));
    }
    if enabled("multi") {
        if let Err(error) = phase_multi(&host, &server_dir, &root_path, &mut failures).await {
            failures.push(format!("multi 中止：{error}"));
        }
    }
    Ok(failures)
}

#[test]
#[ignore = "需要真实远端，设置 QC_STAB_* 环境变量后用 --ignored 运行"]
fn real_host_server_stability() {
    if env("QC_STAB_HOST").is_none() {
        println!("[stab] 未设置 QC_STAB_HOST，跳过");
        return;
    }
    let failures = tauri::async_runtime::block_on(run()).expect("真机稳定性测试无法开始");
    for failure in &failures {
        println!("[stab][FAIL] {failure}");
    }
    assert!(
        failures.is_empty(),
        "真机稳定性测试发现 {} 个问题",
        failures.len()
    );
}
