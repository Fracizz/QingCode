# Keep a read handle while the transient route is claimed and unlinked.
exec 3<"$QINGCODE_CODEX_HANDOFF" || exit 1
agent=$QINGCODE_PREWARM_AGENT
unset QINGCODE_PREWARM_AGENT QINGCODE_CODEX_HANDOFF
"$agent" 3<&-
destination=$(cat <&3)
exec 3<&-
[ -n "$destination" ] && cd "$destination" || exit 1
