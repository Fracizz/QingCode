# A separate server for this PTY. Keep the password out of the terminal,
# shell history and child command lines.
qc_nonce=$QINGCODE_PREWARM_NONCE
qc_anchor=$QINGCODE_CODEX_ANCHOR
unset QINGCODE_PREWARM_NONCE QINGCODE_CODEX_ANCHOR
# Start in the QingCode-owned empty directory, never a user project.
[ -n "$qc_anchor" ] && [ ! -L "$qc_anchor" ] || exit 1
mkdir -p -- "$qc_anchor" && cd -P -- "$qc_anchor" || exit 1
# 清掉此前 CLI 会话留下的空目录（如 .claude，find 默认不跟随链接）；
# 仍有文件（如已领取的会话正在使用）时报告目录被占用，由预热池稍后重试。
find . -mindepth 1 -depth -type d -exec rmdir {} + 2>/dev/null
# Claude Code 运行期间一直在启动目录持有 .claude/scheduled_tasks.lock（已领取的会话也是），只剩它时不算占用。
[ -z "$(ls -A .)" ] || { [ "$(ls -A .)" = .claude ] && [ ! -L .claude ] && [ "$(ls -A .claude)" = scheduled_tasks.lock ]; } || { printf 'QC-%s-anchor_busy!
' "$qc_nonce"; exit 1; }
command -v opencode >/dev/null 2>&1 || { printf 'QC-%s-cli_not_installed!
' "$qc_nonce"; exit 1; }
qc_dir=$(mktemp -d) || exit 1
qc_pass=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n') || exit 1
[ "${#qc_pass}" = 48 ] || exit 1
qc_opencode() { OPENCODE_SERVER_USERNAME=qingcode OPENCODE_SERVER_PASSWORD="$qc_pass" opencode "$@"; }
OPENCODE_SERVER_USERNAME=qingcode OPENCODE_SERVER_PASSWORD="$qc_pass" opencode serve --hostname 127.0.0.1 --port 0 --mdns=false >"$qc_dir/server.log" 2>&1 &
qc_server=$!
qc_cleanup() { kill "$qc_server" 2>/dev/null; wait "$qc_server" 2>/dev/null; rm -f "$qc_dir/server.log"; rmdir "$qc_dir"; }
trap qc_cleanup EXIT
trap 'exit 1' HUP TERM
while kill -0 "$qc_server" 2>/dev/null; do
    qc_url=$(sed -n 's,^opencode server listening on \(http://127\.0\.0\.1:[0-9][0-9]*\)$,\1,p' "$qc_dir/server.log" | head -n 1)
    [ -n "$qc_url" ] && break
    sleep 0.1
done
[ -n "$qc_url" ] || exit 1
qc_python=$(command -v python3 || command -v python) || exit 1
printf 'QC-%s-ready!' "$qc_nonce"
IFS= read -r qc_input || exit 1
qc_target=$(printf %s "$qc_input" | base64 -d) && cd "$qc_target" || exit 1
QC_OPENCODE_PASSWORD="$qc_pass" "$qc_python" - "$qc_url" "$PWD" <<'PYTHON' || exit 1
import base64, json, os, sys
try:
    from urllib.request import Request, ProxyHandler, build_opener
    from urllib.parse import urlencode
except ImportError:
    from urllib2 import Request, ProxyHandler, build_opener
    from urllib import urlencode
url, directory = sys.argv[1:]
auth = base64.b64encode(("qingcode:" + os.environ["QC_OPENCODE_PASSWORD"]).encode()).decode("ascii")
request = Request(url + "/path?" + urlencode({"directory": directory}), headers={"Authorization": "Basic " + auth})
response = build_opener(ProxyHandler({})).open(request, timeout=4)
try:
    expected = directory if sys.version_info[0] >= 3 else directory.decode("utf-8")
    if os.path.realpath(json.load(response)["directory"]) != os.path.realpath(expected):
        sys.exit(1)
finally:
    response.close()
PYTHON
printf 'QC-%s-cwd!' "$qc_nonce"
qc_opencode attach "$qc_url" --dir "$PWD"
qc_cleanup
trap - EXIT HUP TERM
