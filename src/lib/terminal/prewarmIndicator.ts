import type { TerminalTab } from '../../types'

type PrewarmView = Pick<TerminalTab, 'prewarm' | 'launchCommand'>

/**
 * 预热标志只表示「用户看到的内容确实来自预热」：
 * - 无启动命令的普通 Shell：领取到预热 Shell 即为真实命中；
 * - 带启动命令的配置（如 claude）：只有领取到对应 CLI 预热会话（kind=profile）才算，
 *   仅领取预热 Shell 再冷启动命令时不显示，以免把冷启动误标为预热。
 * 诊断统计仍按原始 outcome 记录，不受此处影响。
 */
function prewarmMatchesView(terminal: PrewarmView): boolean {
  return !terminal.launchCommand?.trim() || terminal.prewarm?.kind === 'profile'
}

export function showsPrewarmHit(terminal: PrewarmView): boolean {
  return terminal.prewarm?.outcome === 'hit' && prewarmMatchesView(terminal)
}

export function showsPrewarmPending(terminal: PrewarmView): boolean {
  return terminal.prewarm?.outcome === 'reserved' && prewarmMatchesView(terminal)
}
