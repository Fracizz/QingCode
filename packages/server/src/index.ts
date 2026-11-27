/**
 * package.json 的 main 指向本文件；server 本身是 CLI，这里只导出
 * 桌面端需要对齐的版本号与路径派生规则，不启动任何进程。
 */
export { defaultStateDir, localPipeName, resolvePaths } from './paths'
export type { DaemonInfo, PathOptions, ServerPaths } from './paths'
export { VERSION } from './version'
