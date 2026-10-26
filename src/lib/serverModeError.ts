import { translate } from './i18n'
import { useProjectStore } from '../store/projectStore'
import {
  isSshProject,
  sshConnectionIdFromUri,
  switchSshConnectionMode,
} from './sshWorkspace'

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

/** 当前项目所属的 SSH 连接；非 SSH 项目或拿不到连接时返回 undefined。 */
export function currentSshConnectionId(): string | undefined {
  const project = useProjectStore.getState().currentProject
  if (!project || !isSshProject(project)) return undefined
  return project.connection_id || sshConnectionIdFromUri(project.path) || undefined
}

/**
 * 把指定连接切到 SSH 模式：保存连接配置并断开重连当前项目。
 * 不停止其他项目的远端服务，失败向上抛出由调用方提示。
 */
export async function switchToSshMode(connectionId: string): Promise<void> {
  await switchSshConnectionMode(connectionId, 'ssh')
}

/** 把指定连接切回 Server 模式：保存连接配置并断开重连当前项目。 */
export async function switchToServerMode(connectionId: string): Promise<void> {
  await switchSshConnectionMode(connectionId, 'server')
}

/**
 * Server 模式错误的一键修复操作：切到 SSH 模式。
 * 非 Server 模式错误或无法解析连接时返回 undefined，调用方只在相关错误上挂 action。
 */
export function serverModeErrorAction(
  error: unknown,
  t: Translator = translate,
  connectionId: string = currentSshConnectionId() ?? '',
): { label: string; onAction: () => Promise<void> } | undefined {
  if (!isServerModeError(error)) return undefined
  if (!connectionId && !currentSshConnectionId()) return undefined
  return {
    label: t('切到 SSH 模式'),
    onAction: async () => {
      const pushToast = useProjectStore.getState().pushToast
      try {
        const target = connectionId || currentSshConnectionId()
        if (!target) throw new Error('缺少 SSH 连接')
        await switchToSshMode(target)
        pushToast('success', t('已切换到 SSH 模式'))
      } catch (switchError) {
        pushToast('error', t('切到 SSH 模式失败: {error}', { error: String(switchError) }))
      }
    },
  }
}
