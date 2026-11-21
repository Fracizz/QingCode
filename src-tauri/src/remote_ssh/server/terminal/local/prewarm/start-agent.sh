# Keep a read handle while the transient route is claimed and unlinked.
exec 3<"$QINGCODE_CODEX_HANDOFF" || exit 1
agent=$QINGCODE_PREWARM_AGENT
anchor=$QINGCODE_CODEX_ANCHOR
unset QINGCODE_PREWARM_AGENT QINGCODE_CODEX_HANDOFF QINGCODE_CODEX_ANCHOR
# QingCode-owned empty launch directory, never a user project. Refuse a link
# or any content so the CLI never loads project files here.
[ -n "$anchor" ] && [ ! -L "$anchor" ] || exit 1
mkdir -p -- "$anchor" && cd -P -- "$anchor" || exit 1
[ -z "$(ls -A .)" ] || exit 1
# CLI 不在 PATH 上时报告「未安装」，预热暂停并提示，而不是笼统地启动失败。
if ! command -v -- "$agent" >/dev/null 2>&1; then
    printf 'QC-%s-cli_not_installed!
' "$QINGCODE_PREWARM_NONCE"
    exit 1
fi
if [ "$agent" = codex ]; then
    # Trust only this directory and only for this process; config.toml is untouched.
    case $PWD in *[\"\\]*) exit 1 ;; esac
    "$agent" -c "projects={\"$PWD\"={trust_level=\"trusted\"}}" 3<&-
else
    "$agent" 3<&-
fi
destination=$(cat <&3)
exec 3<&-
[ -n "$destination" ] && cd "$destination" || exit 1
