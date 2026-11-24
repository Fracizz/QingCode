# pi 没有会话内切换目录的命令：Node 加载器在专用空目录预加载模块，领取时
# 从 stdin 读目标目录、切换后运行 pi 入口，并把目录写回给退出后的 Shell。
qc_nonce=$QINGCODE_PREWARM_NONCE
qc_anchor=$QINGCODE_CODEX_ANCHOR
unset QINGCODE_PREWARM_NONCE QINGCODE_CODEX_ANCHOR QINGCODE_PREWARM_AGENT
# Start in the QingCode-owned empty directory, never a user project.
[ -n "$qc_anchor" ] && [ ! -L "$qc_anchor" ] || exit 1
mkdir -p -- "$qc_anchor" && cd -P -- "$qc_anchor" || exit 1
# 清掉此前 CLI 会话留下的空目录（如 .claude，find 默认不跟随链接）；
# 仍有文件（如已领取的会话正在使用）时报告目录被占用，由预热池稍后重试。
find . -mindepth 1 -depth -type d -exec rmdir {} + 2>/dev/null
# Claude Code 运行期间一直在启动目录持有 .claude/scheduled_tasks.lock（已领取的会话也是），只剩它时不算占用。
[ -z "$(ls -A .)" ] || { [ "$(ls -A .)" = .claude ] && [ ! -L .claude ] && [ "$(ls -A .claude)" = scheduled_tasks.lock ]; } || { printf 'QC-%s-anchor_busy!
' "$qc_nonce"; exit 1; }
qc_pi=$(command -v pi) || { printf 'QC-%s-cli_not_installed!\n' "$qc_nonce"; exit 1; }
if qc_node=$(command -v node); then
    qc_base=$(mktemp -d) || exit 1
    trap 'rm -rf -- "$qc_base"' EXIT
    trap 'exit 1' HUP TERM
    cat >"$qc_base/preload.mjs" <<'QC_PI_PRELOAD'
__QINGCODE_PI_PRELOAD__
QC_PI_PRELOAD
    QC_PI_BIN=$qc_pi QC_PI_NONCE=$qc_nonce QC_PI_RETURN=$qc_base/cwd "$qc_node" "$qc_base/preload.mjs"
    qc_status=$?
    qc_target=$(cat "$qc_base/cwd" 2>/dev/null)
    rm -rf -- "$qc_base"
    trap - EXIT HUP TERM
    [ -n "$qc_target" ] && cd "$qc_target" || exit 1
    # 75：加载器找不到 pi 的 Node 入口，已切到目标目录，由 Shell 普通启动。
    [ "$qc_status" != 75 ] || pi
else
    printf 'QC-%s-ready!' "$qc_nonce"
    IFS= read -r qc_input || exit 1
    qc_target=$(printf %s "$qc_input" | base64 -d) && cd "$qc_target" || exit 1
    printf 'QC-%s-cwd!' "$qc_nonce"
    pi
fi
