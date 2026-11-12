import { Channel } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { safeInvoke } from './tauri'
import { translate } from './i18n'
import type { SshRuntimeConfig } from './sshWorkspace'
import type { ServerPackageInfo } from './sshServerRecovery'
import type { DeferredUpgrade } from './sshServerStatus'

export type UpdatePackageSource =
  { mode: 'automatic'; allowDownload?: boolean } | { mode: 'offline'; directory: string }
export type UpdatePhase =
  | 'connecting'
  | 'checkingPackage'
  | 'downloading'
  | 'uploading'
  | 'restarting'
  | 'verifying'
  | 'restoring'
export const updatePhaseLabels: Record<UpdatePhase, string> = {
  connecting: '正在连接 SSH 并核对项目目录…',
  checkingPackage: '正在校验本机服务包…',
  downloading: '正在本机下载并校验服务包…',
  uploading: '正在通过 SSH 上传并校验服务包…',
  restarting: '正在重启远端服务…',
  verifying: '正在验证远端服务与配对身份…',
  restoring: '更新失败，正在尝试恢复原服务…',
}

type UpdateTarget = { rootUri: string; sshConnectionId: string; config: SshRuntimeConfig }
export interface DirectServerUpdateApi {
  chooseDirectory: () => Promise<string | null>
  prepare: (
    target: UpdateTarget & { packageSource: UpdatePackageSource },
    onProgress: (phase: UpdatePhase) => void
  ) => Promise<ServerPackageInfo>
  update: (
    target: UpdateTarget & { packageDirectory: string; confirmedUpgrade?: DeferredUpgrade },
    onProgress: (phase: UpdatePhase) => void
  ) => Promise<unknown>
}

export function validServerUpdatePackage(info: ServerPackageInfo | null): info is ServerPackageInfo & { directory: string } {
  return Boolean(info?.directory && !info.problem && info.expectedVersion && info.packageVersion === info.expectedVersion)
}

function progressChannel(onProgress: (phase: UpdatePhase) => void) {
  const channel = new Channel<UpdatePhase>()
  channel.onmessage = onProgress
  return channel
}

export const directServerUpdateApi: DirectServerUpdateApi = {
  chooseDirectory: async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: translate('选择离线服务目录'),
    })
    return typeof selected === 'string' ? selected : null
  },
  prepare: (target, onProgress) =>
    safeInvoke('准备远端服务包', 'direct_agent_prepare_update', {
      ...target,
      onProgress: progressChannel(onProgress),
    }),
  update: ({ packageDirectory, confirmedUpgrade, ...target }, onProgress) =>
    safeInvoke('更新远端服务', 'direct_agent_update', {
      ...target,
      options: { packageDirectory, ...(confirmedUpgrade && { confirmedUpgrade }), onProgress: progressChannel(onProgress) },
    }),
}
