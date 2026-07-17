import { safeInvoke, isTauri } from './tauri'

export interface OpenWithStatus {
  registered: boolean
  exe_path: string
  extensions: string[]
  supported: boolean
}

export async function getOpenWithStatus(): Promise<OpenWithStatus | null> {
  if (!isTauri()) return null
  try {
    return await safeInvoke<OpenWithStatus>('查询打开方式', 'get_open_with_status')
  } catch (e) {
    console.error('getOpenWithStatus failed:', e)
    return null
  }
}

export async function registerOpenWith(): Promise<OpenWithStatus> {
  return safeInvoke<OpenWithStatus>('注册打开方式', 'register_file_open_with')
}

export async function unregisterOpenWith(): Promise<OpenWithStatus> {
  return safeInvoke<OpenWithStatus>('取消打开方式', 'unregister_file_open_with')
}
