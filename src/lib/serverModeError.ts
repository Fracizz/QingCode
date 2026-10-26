import { translate } from './i18n'
import { useProjectStore } from '../store/projectStore'
import { switchGlobalSshServerMode } from './sshServerSettings'

/** 后端在 Server 模式无法继续时给错误消息加的统一前缀。 */
export const SERVER_MODE_ERROR_PREFIX = 'Server 模式：'

type Translator = (source: string, values?: Record<string, string | number>) => string

/**
 * safeInvoke 抛出的错误通常带「xxx失败: 」前缀，所以用 includes 判前缀位置，
 * 而不是要求消息以「Server 模式：」开头。
 */
export function isServerModeError(error: unknown): boolean {
  if (error == null) return false
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error)
  return message.includes(SERVER_MODE_ERROR_PREFIX)
}

/**
 * 全局关闭 ssh.server.enabled，之后的新操作全部直连；当前项目的单独覆盖一并移除。
 * 不停止远端 server：已由 daemon 托管的终端继续运行。失败向上抛出由调用方提示。
 */
export async function switchToSshMode(): Promise<void> {
  await switchGlobalSshServerMode(false, useProjectStore.getState().currentProject)
}

/** 全局开启 ssh.server.enabled（切回 Server 模式），当前项目的单独覆盖一并移除。 */
export async function switchToServerMode(): Promise<void> {
  await switchGlobalSshServerMode(true, useProjectStore.getState().currentProject)
}

/**
 * Server 模式错误的一键修复操作：切到 SSH 模式。
 * 非 Server 模式错误返回 undefined，调用方只在相关错误上挂 action。
 */
export function serverModeErrorAction(
  error: unknown,
  t: Translator = translate,
): { label: string; onAction: () => Promise<void> } | undefined {
  if (!isServerModeError(error)) return undefined
  return {
    label: t('切到 SSH 模式'),
    onAction: async () => {
      const pushToast = useProjectStore.getState().pushToast
      try {
        await switchToSshMode()
        pushToast('success', t('已切换到 SSH 模式'))
      } catch (switchError) {
        pushToast('error', t('切到 SSH 模式失败: {error}', { error: String(switchError) }))
      }
    },
  }
}
