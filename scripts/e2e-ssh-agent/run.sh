#!/usr/bin/env bash
# QingCode SSH 远端代理（qingcode-agent）真机端到端验收。
#
# 覆盖范围：`serve` 子集的扫描 / 搜索 / 监视 / 单实例 / 权限 / 会话脱离存活。
# 不覆盖：PTY 持久化、daemon 架构（由其它实现负责）。
#
# 必须在 WSL（或任意 Linux）里运行，Windows 侧调用方式：
#   wsl -d Ubuntu -- bash /mnt/d/Code/QingCode/scripts/e2e-ssh-agent/run.sh
#
# 环境变量（全部必填的会在缺失时报错，脚本内不含任何凭据）：
#   QC_E2E_HOST       远端主机地址（必填）
#   QC_E2E_PASSWORD   远端 SSH 密码（必填；仅写入临时 askpass，退出时删除）
#   QC_E2E_USER       SSH 用户，默认 root
#   QC_E2E_PORT       SSH 端口，默认 22
#   QC_E2E_BINARY     本地 agent 二进制路径，默认 <repo>/src-tauri/target/agent/qingcode-agent-x86_64
#   QC_E2E_WORK       远端一次性工作目录，默认 /tmp/qc-e2e
#   QC_E2E_KEEP=1     保留远端现场用于排查（默认清理）
#
# 退出码：0 全部通过；1 存在失败断言；2 环境/前置条件不满足。

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

: "${QC_E2E_HOST:?需要设置 QC_E2E_HOST（远端主机地址）}"
: "${QC_E2E_PASSWORD:?需要设置 QC_E2E_PASSWORD（远端 SSH 密码）}"
QC_E2E_USER=${QC_E2E_USER:-root}
QC_E2E_PORT=${QC_E2E_PORT:-22}
QC_E2E_BINARY=${QC_E2E_BINARY:-$REPO_ROOT/src-tauri/target/agent/qingcode-agent-x86_64}
QC_E2E_WORK=${QC_E2E_WORK:-/tmp/qc-e2e}
REMOTE=$QC_E2E_USER@$QC_E2E_HOST
REMOTE_PROJECT=$QC_E2E_WORK/project
REMOTE_AGENT_DIR=$REMOTE_PROJECT/.qingcode/agent
REMOTE_BIN=$REMOTE_AGENT_DIR/qingcode-agent-x86_64
STATE_PATH=$REMOTE_AGENT_DIR/agent.json

PASS=0
FAIL=0
FAILED_NAMES=()
TUNNEL_PID=""
AGENT_PID=""
CLEANED=0

pass() { PASS=$((PASS + 1)); printf '[PASS] %s :: %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); printf '[FAIL] %s :: %s\n' "$1" "$2"; }
info() { printf '[INFO] %s\n' "$*"; }
step() { printf '\n===== %s =====\n' "$*"; }

assert_ok() { # assert_ok <名称> <说明> <命令...>
  local name=$1 detail=$2
  shift 2
  if "$@" >/dev/null 2>&1; then pass "$name" "$detail"; else fail "$name" "$detail"; fi
}
assert_eq() { # assert_eq <名称> <实际> <期望>
  if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "got=$2 want=$3"; fi
}
assert_nonempty() { # assert_nonempty <名称> <值> <说明>
  if [ -n "$2" ]; then pass "$1" "${3:-$2}"; else fail "$1" "${3:-空}"; fi
}

die() { printf '\n[中止] %s\n' "$*" >&2; exit 2; }

# --------------------------------------------------------------------------- #
# SSH/SCP 封装：WSL 无 sshpass，用 askpass + setsid 实现非交互密码认证
# --------------------------------------------------------------------------- #

setup_askpass() {
  LOCAL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/qc-e2e-local.XXXXXX") || die "无法创建本地临时目录"
  ASKPASS=$LOCAL_TMP/askpass.sh
  # 密码走 heredoc 写入，避免特殊字符被 shell 解释
  cat >"$ASKPASS" <<ASKPASS_EOF
#!/bin/sh
cat <<'QC_PASS_EOF'
$QC_E2E_PASSWORD
QC_PASS_EOF
ASKPASS_EOF
  chmod 500 "$ASKPASS"
  export DISPLAY=:0
  export SSH_ASKPASS="$ASKPASS"
  export SSH_ASKPASS_REQUIRE=force
  # GSSAPIAuthentication=no：远端的 sshd 会广告 gssapi-with-mic，WSL 客户端在
  # 没有 Kerberos 的环境下会先等 ~20s 才回退到密码认证；关掉后单次连接 0.2s。
  # 主程序走 russh，本身不做 GSSAPI，因此这只是验收脚本的环境适配。
  SSH_OPTS=(-p "$QC_E2E_PORT" -o StrictHostKeyChecking=no
            -o "UserKnownHostsFile=$LOCAL_TMP/known_hosts" -o LogLevel=ERROR
            -o GSSAPIAuthentication=no -o ConnectTimeout=15 -o ServerAliveInterval=15)
  SCP_OPTS=(-P "$QC_E2E_PORT" -o StrictHostKeyChecking=no
            -o "UserKnownHostsFile=$LOCAL_TMP/known_hosts" -o LogLevel=ERROR
            -o GSSAPIAuthentication=no)
}

S() { setsid -w ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }
SCP_TO() { setsid -w scp "${SCP_OPTS[@]}" "$1" "$REMOTE:$2"; }

start_tunnel() {
  LOCAL_PORT=$(python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
)
  setsid -w ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes \
    -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$AGENT_PORT" "$REMOTE" \
    >"$LOCAL_TMP/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  local i
  for i in $(seq 1 80); do
    if python3 -c "import socket;socket.create_connection(('127.0.0.1',$LOCAL_PORT),0.2).close()" 2>/dev/null; then
      info "隧道就绪：本地 127.0.0.1:$LOCAL_PORT -> 远端 127.0.0.1:$AGENT_PORT"
      return 0
    fi
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      printf '隧道进程提前退出：\n'; cat "$LOCAL_TMP/tunnel.log" 2>/dev/null
      return 1
    fi
    sleep 0.15
  done
  return 1
}

stop_tunnel() {
  [ -n "$TUNNEL_PID" ] || return 0
  kill "$TUNNEL_PID" 2>/dev/null
  wait "$TUNNEL_PID" 2>/dev/null
  TUNNEL_PID=""
}

# client.py 输出里的 [PASS]/[FAIL] 计入总账
run_client() { # run_client <phase> [额外参数...]
  local phase=$1
  shift
  local out
  out=$(python3 "$SCRIPT_DIR/client.py" \
    --host 127.0.0.1 --port "$LOCAL_PORT" --token "$AGENT_TOKEN" \
    --phase "$phase" --expect-version "$EXPECT_VERSION" \
    --ssh "ssh ${SSH_OPTS[*]} $REMOTE" \
    --remote-project "$REMOTE_PROJECT" --agent-pid "${AGENT_PID:-0}" "$@" 2>&1)
  local status=$?
  printf '%s\n' "$out"
  local passed failed line
  passed=$(printf '%s\n' "$out" | grep -c '^\[PASS\]')
  failed=$(printf '%s\n' "$out" | grep -c '^\[FAIL\]')
  PASS=$((PASS + passed))
  FAIL=$((FAIL + failed))
  while IFS= read -r line; do
    [ -n "$line" ] && FAILED_NAMES+=("${line#\[FAIL\] }")
  done < <(printf '%s\n' "$out" | grep '^\[FAIL\]')
  return $status
}

parse_state() { # 从 agent.json 提取字段，解析失败返回非零
  python3 - "$1" <<'PY'
import json, sys
try:
    data = json.loads(sys.argv[1])
    print(data["port"], data["token"], data["pid"], data["version"])
except Exception:
    sys.exit(1)
PY
}

cleanup_remote() {
  [ "$CLEANED" = "1" ] && return 0
  [ "${REMOTE_READY:-0}" = "1" ] || return 0
  CLEANED=1
  if [ "${QC_E2E_KEEP:-0}" = "1" ]; then
    info "QC_E2E_KEEP=1：保留远端现场（$REMOTE_PROJECT、agent pid ${AGENT_PID:-?}）"
    return 0
  fi
  [ -n "$AGENT_PID" ] && S "kill $AGENT_PID 2>/dev/null" >/dev/null 2>&1
  # 兜底：按项目根精确匹配（[q] 规避 pkill 命中自身命令行）
  S "pkill -f '[q]ingcode-agent-x86_64 serve --root $REMOTE_PROJECT' 2>/dev/null" >/dev/null 2>&1
  S "rm -rf '$QC_E2E_WORK'; rm -f /etc/qc-e2e-probe-*.txt" >/dev/null 2>&1
}

cleanup() {
  local status=$?
  stop_tunnel
  cleanup_remote
  [ -n "${LOCAL_TMP:-}" ] && rm -rf "$LOCAL_TMP"
  exit $status
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------------- #
# 阶段 0：预检
# --------------------------------------------------------------------------- #

step "阶段 0：环境预检"

if [ "$(uname -s)" != "Linux" ]; then
  die "请在 WSL/Linux 中运行：wsl -d Ubuntu -- bash $(wslpath -u "$0" 2>/dev/null || echo "$0")"
fi
assert_ok "运行环境为 Linux/WSL" "$(uname -sr)" true
command -v python3 >/dev/null || die "缺少 python3"
[ -f "$QC_E2E_BINARY" ] || die "找不到 agent 二进制：$QC_E2E_BINARY（先跑 scripts/build-agent.ps1 -Targets x86_64）"
info "本地二进制：$QC_E2E_BINARY ($(du -h "$QC_E2E_BINARY" | cut -f1))"

EXPECT_VERSION=$(tr -d '\r' <"$REPO_ROOT/src-tauri/qingcode-agent/Cargo.toml" | sed -n 's/^version = "\(.*\)"$/\1/p' | head -1)
[ -n "$EXPECT_VERSION" ] || die "无法从 qingcode-agent/Cargo.toml 解析版本号"
info "仓库期望版本：$EXPECT_VERSION"

setup_askpass
REMOTE_READY=1

REMOTE_UNAME=$(S "uname -m" 2>/dev/null) || die "SSH 连接失败：$REMOTE（检查 QC_E2E_HOST / QC_E2E_PASSWORD / QC_E2E_PORT）"
assert_eq "远端架构 x86_64" "$REMOTE_UNAME" "x86_64"
info "远端发行版：$(S 'cat /etc/os-release | grep ^PRETTY_NAME=' 2>/dev/null | cut -d= -f2- | tr -d '\"')"
info "远端 init：$(S 'ps -p 1 -o comm=' 2>/dev/null | tr -d '\n')"
info "SELinux：$(S 'command -v getenforce >/dev/null && getenforce || echo 未安装' 2>/dev/null | tr -d '\n')"

if S "command -v rg" >/dev/null 2>&1; then
  fail "远端不应有 rg（本验收要求验证代理内建搜索实现）" "远端存在 $(S 'command -v rg')"
else
  pass "远端无 rg（搜索必须由代理内建 grep/ignore 实现）" "command -v rg 为空"
fi

# --------------------------------------------------------------------------- #
# 阶段 1：远端一次性项目现场
# --------------------------------------------------------------------------- #

step "阶段 1：构造远端项目现场"

S bash -s >/dev/null <<REMOTE_PREP
set -eu
rm -rf '$QC_E2E_WORK'
mkdir -p '$REMOTE_PROJECT/src/deep' '$REMOTE_AGENT_DIR'
printf 'fn main() { println!("hello world from 远端"); }\n' > '$REMOTE_PROJECT/src/main.rs'
printf 'deep nested\njust nested\n' > '$REMOTE_PROJECT/src/deep/nested.txt'
printf '第一行占位\n这里包含命中关键字\n第三行也有命中\n' > '$REMOTE_PROJECT/中文文件.txt'
{ printf 'hello bigline '; head -c 3145728 /dev/zero | tr '\\0' 'x'; printf '\n'; } > '$REMOTE_PROJECT/big.txt'
ln -sfn /etc '$REMOTE_PROJECT/escape'
REMOTE_PREP

LAYOUT=$(S "ls -A '$REMOTE_PROJECT' | tr '\n' ' '" 2>/dev/null)
assert_nonempty "远端现场创建成功" "$LAYOUT" "$LAYOUT"
assert_eq "中文文件名与符号链接就位" \
  "$(S "[ -f '$REMOTE_PROJECT/中文文件.txt' ] && [ -L '$REMOTE_PROJECT/escape' ] && readlink '$REMOTE_PROJECT/escape'" 2>/dev/null)" \
  "/etc"
assert_eq "big.txt 单行 3MB（行数=1）" "$(S "wc -l < '$REMOTE_PROJECT/big.txt'" 2>/dev/null | tr -d ' ')" "1"

# --------------------------------------------------------------------------- #
# 阶段 2：上传二进制（模拟客户端 SFTP 部署：临时文件 + rename + chmod 755）
# --------------------------------------------------------------------------- #

step "阶段 2：上传 agent 二进制"

LOCAL_SHA=$(sha256sum "$QC_E2E_BINARY" | cut -d' ' -f1)
SCP_TO "$QC_E2E_BINARY" "$REMOTE_AGENT_DIR/qingcode-agent.tmp-e2e" || die "scp 上传失败"
S "mv -f '$REMOTE_AGENT_DIR/qingcode-agent.tmp-e2e' '$REMOTE_BIN' && chmod 755 '$REMOTE_BIN'" || die "远端落位失败"
assert_eq "二进制大小一致" "$(S "stat -c %s '$REMOTE_BIN'" 2>/dev/null | tr -d ' ')" \
  "$(stat -c %s "$QC_E2E_BINARY")"
assert_eq "二进制 sha256 一致" "$(S "sha256sum '$REMOTE_BIN' | cut -d' ' -f1" 2>/dev/null)" "$LOCAL_SHA"
assert_eq "二进制权限 755" "$(S "stat -c %a '$REMOTE_BIN'" 2>/dev/null | tr -d ' ')" "755"
assert_eq "二进制版本号" "$(S "'$REMOTE_BIN' --version" 2>/dev/null | tr -d '\r')" "qingcode-agent $EXPECT_VERSION"

# --------------------------------------------------------------------------- #
# 阶段 3：按客户端一致的方式启动并轮询状态文件
# --------------------------------------------------------------------------- #

step "阶段 3：启动 agent（nohup setsid，脱离 SSH 会话）"

# 与 src-tauri/src/remote_ssh/agent.rs deploy_agent_command 完全同形
LAUNCH_CMD="nohup setsid '$REMOTE_BIN' serve --root '$REMOTE_PROJECT' --state '$STATE_PATH' >/dev/null 2>&1 &"
timeout 30 setsid -w ssh "${SSH_OPTS[@]}" "$REMOTE" "$LAUNCH_CMD" >/dev/null 2>&1

STATE_JSON=""
for _ in $(seq 1 60); do
  STATE_JSON=$(S "cat '$STATE_PATH' 2>/dev/null" 2>/dev/null)
  if [ -n "$STATE_JSON" ]; then
    if PARSED=$(parse_state "$STATE_JSON" 2>/dev/null) && [ -n "$PARSED" ]; then
      read -r AGENT_PORT AGENT_TOKEN AGENT_PID AGENT_VERSION <<<"$PARSED"
      break
    fi
  fi
  AGENT_PORT=""
  sleep 0.25
done
[ -n "${AGENT_PORT:-}" ] || die "状态文件未就绪（agent 启动失败？）"
info "状态文件：port=$AGENT_PORT pid=$AGENT_PID version=$AGENT_VERSION"
assert_eq "状态文件版本与二进制一致" "$AGENT_VERSION" "$EXPECT_VERSION"
assert_eq "agent.json 权限 0600" "$(S "stat -c %a '$STATE_PATH'" 2>/dev/null | tr -d ' ')" "600"
assert_ok "agent 进程存活" "pid=$AGENT_PID" S "kill -0 $AGENT_PID"

LISTEN=$(S "ss -ltnp 2>/dev/null | grep ':$AGENT_PORT '" 2>/dev/null)
assert_eq "只监听 127.0.0.1（不暴露到 0.0.0.0）" \
  "$(printf '%s' "$LISTEN" | grep -c '127.0.0.1:' || true)" "1"

# --------------------------------------------------------------------------- #
# 阶段 4：隧道 + 协议断言
# --------------------------------------------------------------------------- #

step "阶段 4：SSH 隧道 + 协议断言（ping / scan / search / 越界）"

start_tunnel || die "隧道建立失败"
run_client core
CORE_STATUS=$?

# --------------------------------------------------------------------------- #
# 阶段 5：watch
# --------------------------------------------------------------------------- #

step "阶段 5：文件监视断言"

run_client watch
WATCH_STATUS=$?

# --------------------------------------------------------------------------- #
# 阶段 6：断开 SSH 会话后 agent 继续存活
# --------------------------------------------------------------------------- #

step "阶段 6：断开会话 / 重连"

stop_tunnel
sleep 1.0
LEFT_SSH=$(pgrep -af "[s]sh .*$QC_E2E_HOST" 2>/dev/null)
assert_eq "本地 SSH 会话已全部关闭" "$(printf '%s' "$LEFT_SSH" | grep -c . || true)" "0"
if S "kill -0 '$AGENT_PID'" >/dev/null 2>&1; then
  pass "隧道断开后远端 agent 仍存活" "pid=$AGENT_PID etimes=$(S "ps -p '$AGENT_PID' -o etimes= 2>/dev/null" | tr -d ' ')"
else
  fail "隧道断开后远端 agent 仍存活" "pid=$AGENT_PID 已消失"
fi

start_tunnel || die "重连隧道失败"
run_client ping
PING_STATUS=$?

# --------------------------------------------------------------------------- #
# 阶段 7：单实例锁
# --------------------------------------------------------------------------- #

step "阶段 7：单实例锁（第二个实例退出码 3，状态文件不变）"

SHA_BEFORE=$(S "sha256sum '$STATE_PATH' | cut -d' ' -f1" 2>/dev/null)
SECOND_ERR=$LOCAL_TMP/second.err
S "'$REMOTE_BIN' serve --root '$REMOTE_PROJECT' --state '$STATE_PATH'" >/dev/null 2>"$SECOND_ERR"
SECOND_RC=$?
SHA_AFTER=$(S "sha256sum '$STATE_PATH' | cut -d' ' -f1" 2>/dev/null)
assert_eq "第二个实例退出码为 3" "$SECOND_RC" "3"
assert_eq "状态文件字节不变（未被覆盖）" "$SHA_AFTER" "$SHA_BEFORE"
assert_nonempty "第二个实例给出可诊断的错误信息" "$(tr -d '\r' <"$SECOND_ERR")" "$(tr -d '\r' <"$SECOND_ERR")"
assert_ok "端口未被抢占（原实例仍在服务）" "pid=$AGENT_PID" S "kill -0 $AGENT_PID"

# --------------------------------------------------------------------------- #
# 阶段 8：清理与残留检查
# --------------------------------------------------------------------------- #

step "阶段 8：清理与残留检查"

stop_tunnel
if [ "${QC_E2E_KEEP:-0}" = "1" ]; then
  info "QC_E2E_KEEP=1：跳过清理"
else
  S "kill '$AGENT_PID' 2>/dev/null" >/dev/null 2>&1
  for _ in $(seq 1 40); do
    S "kill -0 '$AGENT_PID' 2>/dev/null" || break
    sleep 0.1
  done
  if S "kill -0 '$AGENT_PID'" >/dev/null 2>&1; then
    fail "agent 进程已退出" "pid=$AGENT_PID 仍存活"
  else
    pass "agent 进程已退出" "pid=$AGENT_PID 已不存在"
  fi
  S "rm -rf '$QC_E2E_WORK'; rm -f /etc/qc-e2e-probe-*.txt" >/dev/null 2>&1

  assert_eq "远端工作目录已删除" "$(S "[ -e '$QC_E2E_WORK' ] && echo exists || echo gone" 2>/dev/null)" "gone"
  assert_eq "远端残留 agent 进程数" "$(S "pgrep -f '[q]ingcode-agent' 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ')" "0"
  assert_eq "远端端口已释放" "$(S "ss -ltn 2>/dev/null | grep -c ':$AGENT_PORT '" 2>/dev/null || true)" "0"
  assert_eq "远端无 escape 探测文件残留（/etc）" "$(S "ls /etc/qc-e2e-probe-* 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ')" "0"
  AVC=$(S "dmesg 2>/dev/null | grep -c 'avc: *denied' || true" 2>/dev/null | tr -d ' ')
  info "SELinux AVC 拒绝条数（dmesg，仅参考）：${AVC:-未知}"
fi

# --------------------------------------------------------------------------- #
# 汇总
# --------------------------------------------------------------------------- #

step "汇总"
printf '通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '失败项：\n'
  for name in "${FAILED_NAMES[@]}"; do printf '  - %s\n' "$name"; done
  exit 1
fi
printf 'client 退出码：core=%s watch=%s ping=%s\n' "$CORE_STATUS" "$WATCH_STATUS" "$PING_STATUS"
printf '全部断言通过。\n'
exit 0
