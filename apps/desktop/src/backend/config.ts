// main 通过 utilityProcess 的 env 注入，T5 直接用这里的路径拉起本机/远端 server。
export type BackendConfig = {
  userData: string
  resourcesPath: string
  electronPath: string
  appVersion: string
}

export const backendConfig: BackendConfig = {
  userData: process.env['QN_USER_DATA'] ?? '',
  resourcesPath: process.env['QN_RESOURCES_PATH'] ?? '',
  electronPath: process.env['QN_ELECTRON_PATH'] ?? process.execPath,
  appVersion: process.env['QN_APP_VERSION'] ?? '0.0.1',
}
