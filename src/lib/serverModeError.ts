import { translate } from './i18n'
import { useProjectStore } from '../store/projectStore'
import { sshConnectionIdFromUri } from './sshWorkspace'
import { safeInvoke } from './tauri'
import { parseSshServerState } from './sshServerStatus'
import { confirmDialog } from '../store/confirmStore'

/** 后端在 Server 模式无法继续时给错误消息加的统一前缀。 */
export const SERVER_MODE_ERROR_PREFIX = 'Server 模式：'

type Translator = (source: string, values?: Record<string, string | number>) => string

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/**
 * safeInvoke 抛出的错误通常带「xxx失败: 」前缀，所以用 includes 判前缀位置，
 * 而不是要求消息以「Server 模式：」开头。
 */
export function isServerModeError(error: unknown): boolean {
  if (error == null) return false
  return errorMessage(error).includes(SERVER_MODE_ERROR_PREFIX)
}

/**
 * 版本不匹配时更新服务，其余 Server 错误重启服务；不改变连接模式。
 * 调用方在异步请求开始前捕获完整项目根，不能从报错时的当前项目或连接猜测。
 * 后端仍负责信任门禁；没有明确的 SSH 根时不提供操作。
 */
export function serverModeErrorAction(
  error: unknown,
  rootUri: string,
  t: Translator = translate,
): { label: string; onAction: () => Promise<void> } | undefined {
  if (!isServerModeError(error) || !sshConnectionIdFromUri(rootUri)) return undefined
  const update = /(?:daemon|server|远端服务程序)\s*版本不匹配/.test(errorMessage(error))
  const label = update ? t('更新远端服务') : t('重启远端服务')
  let pending = false
  return {
    label,
    onAction: async () => {
      if (pending) return
      pending = true
      const pushToast = useProjectStore.getState().pushToast
      try {
        const accepted = await confirmDialog({
          title: label,
          message: update
            ? t('将安装与当前客户端匹配的远端服务并替换旧版本。更新会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。')
            : t('重启会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。'),
          kind: 'warning',
          confirmLabel: update ? t('更新') : t('重启'),
          cancelLabel: t('取消'),
        })
        if (!accepted) return
        const result = await safeInvoke<unknown>(label, update ? 'ssh_server_update' : 'ssh_server_restart', { rootUri })
        const state = parseSshServerState(result)
        // 文件服务 readyServer/serve 不代表终端依赖的 daemon 已完成升级。
        if (update && (state?.phase !== 'readyServer' || state.transport !== 'daemon')) {
          pushToast('warn', t('远端服务尚未就绪'), state?.reason ?? undefined)
          return
        }
        if (state?.phase === 'readyServer') {
          pushToast('success', update ? t('已更新远端服务，请重新新建终端或重试原操作') : t('已重启远端服务'))
        } else if (state?.phase === 'readyDirect') {
          pushToast('warn', t('远端服务尚未就绪'), state.reason ?? undefined)
        } else {
          pushToast('info', t('正在部署远端服务…'))
        }
      } catch (retryError) {
        pushToast('error', update
          ? t('更新远端服务失败: {error}', { error: String(retryError) })
          : t('重启远端服务失败: {error}', { error: String(retryError) }))
      } finally {
        pending = false
      }
    },
  }
}
