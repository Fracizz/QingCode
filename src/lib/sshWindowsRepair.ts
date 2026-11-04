import { safeInvoke } from './tauri'
import { confirmDialog, confirmDialogWithCheckbox } from '../store/confirmStore'

export type WindowsSshRepairPlan = {
  configSha256: string
  originalBytes: number
  compactBytes: number
  activeConnections: number
  needsRepair: boolean
}

export const SSH_REPAIR_CHECKBOX = '同时修复 Windows SSH 握手兼容性'
export const SSH_REPAIR_DETAIL = '仅删除 sshd_config 的空行和整行注释；自动备份配置及权限，校验有效配置一致后重启 Windows SSH 服务。会中断该主机现有 SSH 连接；取消勾选将跳过此修复。'

export function isWindowsSshRoot(rootUri: string): boolean {
  return /^ssh:\/\/[^/]+\/[A-Za-z]:\//.test(rootUri)
}

/** Both server restart entry points use the same preflight and explicit choice. */
export async function confirmSshServerRestart(
  rootUri: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  retryOnly = false,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false
  const options = {
    ...(signal ? { signal } : {}),
    title: t(retryOnly ? '重试 SSH 连接' : '重启远端服务'),
    message: t(retryOnly
      ? '检测到 Windows SSH 握手异常，可修复兼容性后重试。重启 Windows SSH 服务会中断此主机的现有连接。'
      : '重启会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。'),
    kind: 'warning' as const,
    confirmLabel: t(retryOnly ? '重试' : '重启'),
    cancelLabel: t('取消'),
  }
  let plan: WindowsSshRepairPlan | null = null
  if (isWindowsSshRoot(rootUri)) {
    try {
      plan = await safeInvoke<WindowsSshRepairPlan>('检查 Windows SSH 兼容修复', 'ssh_windows_repair_plan', { rootUri })
    } catch {
      // A missing admin privilege, offline host or unsupported service must not
      // prevent an ordinary qingcode-server restart.
    }
  }
  if (signal?.aborted) return false
  if (!plan?.needsRepair) return retryOnly ? true : confirmDialog(options)
  const choice = await confirmDialogWithCheckbox({
    ...options,
    detail: t('检测到 {count} 条 SSH 连接；配置将从 {before} 字节精简至 {after} 字节。', {
      count: plan.activeConnections, before: plan.originalBytes, after: plan.compactBytes,
    }),
    checkbox: { label: t(SSH_REPAIR_CHECKBOX), detail: t(SSH_REPAIR_DETAIL), defaultChecked: true },
  })
  if (signal?.aborted || !choice.confirmed) return false
  if (choice.checked) {
    await safeInvoke('修复 Windows SSH 兼容性', 'ssh_windows_repair', {
      rootUri, expectedSha256: plan.configSha256,
    })
  }
  return !signal?.aborted
}
