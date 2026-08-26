import { translate } from './i18n'
import { isTauri, safeInvoke } from './tauri'
import { useProjectStore } from '../store/projectStore'

export interface LanguageComponentStatus {
  id: string
  name: string
  installed: boolean
  extensions: string[]
}

export type CodeNavigationAvailability =
  | { kind: 'available'; component?: LanguageComponentStatus }
  | { kind: 'checking' }
  | { kind: 'missing-component'; component: LanguageComponentStatus }
  | { kind: 'unsupported'; extension: string | null }

let cachedStatuses: LanguageComponentStatus[] | null = null
let statusesRequest: Promise<LanguageComponentStatus[]> | null = null
let statusCheckFailed = false

function fileExtension(path: string): string | null {
  const fileName = path.split(/[\\/]/).pop() ?? ''
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return null
  return fileName.slice(dot + 1).toLowerCase()
}

/** Vue SFC semantic navigation is not implemented; suppress its Ctrl+click affordance. */
export function isDefinitionLinkEnabledForPath(path: string): boolean {
  return fileExtension(path) !== 'vue'
}

export function codeNavigationAvailabilityForPath(
  path: string,
  statuses: LanguageComponentStatus[]
): CodeNavigationAvailability {
  const extension = fileExtension(path)
  const component = extension
    ? statuses.find(status =>
        status.extensions.some(candidate => candidate.toLowerCase() === extension)
      )
    : undefined
  if (!component) return { kind: 'unsupported', extension }
  return component.installed
    ? { kind: 'available', component }
    : { kind: 'missing-component', component }
}

/**
 * Synchronous capability snapshot used by Ctrl-hover.
 *
 * Keep the link hidden while the first status request is pending. If status
 * detection itself fails (for example against an older backend), preserve the
 * established navigation fallback instead of disabling a potentially usable
 * feature.
 */
export function cachedCodeNavigationAvailability(
  path: string
): CodeNavigationAvailability {
  if (!isTauri() || statusCheckFailed) return { kind: 'available' }
  if (!cachedStatuses) return { kind: 'checking' }
  return codeNavigationAvailabilityForPath(path, cachedStatuses)
}

async function loadLanguageComponentStatuses(): Promise<LanguageComponentStatus[]> {
  if (cachedStatuses) return cachedStatuses
  if (!statusesRequest) {
    statusesRequest = safeInvoke<LanguageComponentStatus[]>(
      '检查代码导航语言组件',
      'language_component_statuses'
    )
      .then(statuses => {
        cachedStatuses = statuses
        return statuses
      })
      .catch(error => {
        statusCheckFailed = true
        throw error
      })
  }
  return statusesRequest
}

export function preloadCodeNavigationAvailability(): void {
  if (!isTauri() || cachedStatuses || statusesRequest || statusCheckFailed) return
  void loadLanguageComponentStatuses().catch(error => {
    console.warn('language component status check failed:', error)
  })
}

export async function codeNavigationAvailability(
  path: string
): Promise<CodeNavigationAvailability> {
  if (!isTauri() || statusCheckFailed) return { kind: 'available' }
  try {
    const statuses = await loadLanguageComponentStatuses()
    return codeNavigationAvailabilityForPath(path, statuses)
  } catch {
    return { kind: 'available' }
  }
}

export function canShowDefinitionLink(availability: CodeNavigationAvailability): boolean {
  return availability.kind === 'available'
}

export function notifyCodeNavigationUnavailable(
  availability: CodeNavigationAvailability
): boolean {
  const projects = useProjectStore.getState()
  if (availability.kind === 'missing-component') {
    projects.pushToast(
      'info',
      translate('未安装 {language} 代码导航组件', {
        language: availability.component.name,
      }),
      translate('无法使用 Ctrl+左键跳转。请重新运行安装程序并勾选 {language} 语言组件。', {
        language: availability.component.name,
      })
    )
    return true
  }
  if (availability.kind === 'unsupported') {
    projects.pushToast(
      'info',
      translate('当前语言暂不支持代码导航'),
      translate('无法使用 Ctrl+左键跳转。')
    )
    return true
  }
  return false
}
