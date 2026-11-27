import path from 'node:path'

// Windows 目标可能同时出现盘符、UNC、\\?\ 长路径前缀与混用斜杠；
// 纯字符串归一用于大小写不敏感的去重/比较，不依赖当前主机的 path 实现。

export type PathImpl = typeof path.win32 | typeof path.posix

/** 旧版 SSH 项目可能保存 SFTP 路径 `/D:/code/repo`，Windows Agent 需要本机盘符路径。 */
export function nativeAgentCwd(cwd: string, platform: string = process.platform): string {
  if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(cwd)) {
    return cwd.slice(1).replace(/\//g, '\\')
  }
  return cwd
}

/** 盘符、UNC 或含反斜杠的路径都按 Windows 语义比较，即使 server 暂时跑在 POSIX 上。 */
export function looksWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\')
}

/** `\\?\C:\x` → `C:\x`；`\\?\UNC\server\share` → `\\server\share`。 */
export function stripLongPathPrefix(value: string): string {
  if (!/^\\\\\?\\/.test(value)) return value
  const rest = value.slice(4)
  return /^UNC\\/i.test(rest) ? `\\\\${rest.slice(4)}` : rest
}

/** 统一斜杠、去掉长路径前缀与尾部斜杠；Windows 路径（或 win32 主机）整体小写。 */
export function normalizePathForCompare(value: string, platform: string = process.platform): string {
  const stripped = stripLongPathPrefix(value).replace(/\\/g, '/')
  const unc = stripped.startsWith('//')
  let text = stripped.replace(/\/+/g, '/')
  if (unc) text = `/${text}`
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  if (text === '/') text = ''
  return platform === 'win32' || looksWindowsPath(value) ? text.toLowerCase() : text
}

/** 保留第一次出现的原字符串，Windows 下大小写与斜杠差异视为同一路径。 */
export function dedupePaths(paths: readonly string[], platform: string = process.platform): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of paths) {
    const key = normalizePathForCompare(item, platform)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

/** child 是否位于 parent 之下（不含相等）；用于递归监听时跳过已覆盖的子目录。 */
export function isPathInside(parent: string, child: string, platform: string = process.platform): boolean {
  const base = normalizePathForCompare(parent, platform)
  const target = normalizePathForCompare(child, platform)
  if (base === target) return false
  if (base === '') return target.startsWith('/')
  return target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** 计算路径关系时选 win32 还是 posix；Windows 风格路径在任何主机上都用 win32。 */
export function pickPathImpl(
  root: string,
  input: string,
  platform: string = process.platform,
): PathImpl {
  return platform === 'win32' || looksWindowsPath(root) || looksWindowsPath(input)
    ? path.win32
    : path.posix
}
