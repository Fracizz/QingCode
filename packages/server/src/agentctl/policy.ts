/**
 * Agent 经 `qn` 命令连回 daemon 时的权限边界。
 *
 * - 只放行只读查询与"提醒用户/打开文件"这类对用户可见的界面动作；
 * - 会在 Agent 沙箱/审批之外执行命令或写文件的方法（run.start、term.write、fs.write、git.commit…）一律拒绝，
 *   否则 Agent 可借 daemon 绕过自己的沙箱（docs/agent-adapters.md R8）；
 * - 不开放 codex.* 与 codex.send：qn 不经手任何 Agent 官方协议，也就无法代答审批（R7）。
 */
export const AGENT_REQ_METHODS: ReadonlySet<string> = new Set([
  'ping',
  'run.list',
  'run.output',
  'term.list',
  'term.attach',
  'term.detach',
  'ui.notify',
  'ui.open',
])
