/** `qn guide` 的说明，随 server 版本发布，保证与命令一致。 */
export const AGENT_GUIDE = `# qn — 在 QingCode 中调度软件能力

\`qn\` 由 QingCode 注入到它拉起的 Agent 与终端中（PATH 里找不到时用 \`$QN_CLI\` / \`%QN_CLI%\`）。
所有命令都可加 \`--json\` 输出机器可读结果；失败时退出码非 0，错误写到 stderr。

## 边界
qn 只做查询和对用户可见的界面动作，不能执行命令或写文件；需要运行命令请用你自己的 shell 工具。

## 提醒用户
    qn notify "构建完成，3 个测试失败" [--title 标题]
在用户桌面弹出系统通知。适合长任务结束、需要用户决策时使用；不要频繁打扰。

## 在用户编辑器中打开文件
    qn open <路径> [--line N] [--column N]
路径可为相对当前目录。

## 运行配置（用户在 QingCode 里启动的程序，如 dev server）
    qn run list
    qn run output <runId> [--since SEQ] [--tail 行数]
只读：可查看日志排查问题，不能启动或停止。

## 终端（用户在 QingCode 里打开的终端）
    qn term list
    qn term read <termId> [--tail 行数]
只读：读取屏幕输出（已去除 ANSI 控制符）。

## 状态
    qn status
`
