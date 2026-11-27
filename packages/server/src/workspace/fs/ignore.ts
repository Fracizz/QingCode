import { matchGlob } from './logic'

// Node 兜底遍历的跳过规则：版本控制/依赖目录、Windows 系统目录，以及简化的 .gitignore。
// 纯逻辑，不读磁盘；search.ts 负责把每层 .gitignore 的内容传进来。

const VCS_SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn'])
const WINDOWS_SKIP_DIRS = new Set(['$recycle.bin', 'system volume information'])

export const MAX_IGNORE_FILE_BYTES = 64 * 1024

export function isSkippedDir(name: string, platform: string = process.platform): boolean {
  const key = name.toLowerCase()
  if (VCS_SKIP_DIRS.has(key)) return true
  return platform === 'win32' && WINDOWS_SKIP_DIRS.has(key)
}

export interface IgnoreRule {
  /** .gitignore 所在目录相对搜索根的路径（posix，根为 ''） */
  base: string
  pattern: string
  negate: boolean
  dirOnly: boolean
}

/** 支持注释、! 取反、结尾 / 仅目录、开头 / 锚定到本目录；不支持转义空格。 */
export function parseIgnore(content: string, base = ''): IgnoreRule[] {
  const normalizedBase = base.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const rules: IgnoreRule[] = []
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const pattern = line.replace(/^\//, '').replace(/\\/g, '/')
    if (pattern.length === 0) continue
    rules.push({ base: normalizedBase, pattern, negate, dirOnly })
  }
  return rules
}

/**
 * 最后一条命中的规则生效；无斜杠的模式匹配任意层 basename（matchGlob 语义），
 * 有斜杠的模式相对 .gitignore 所在目录锚定。Windows 上目录名大小写不敏感。
 */
export function isIgnored(
  relativePath: string,
  isDir: boolean,
  rules: readonly IgnoreRule[],
  caseSensitive = false,
): boolean {
  const relative = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const comparable = caseSensitive ? relative : relative.toLowerCase()
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    let sub: string
    if (rule.base === '') {
      sub = relative
    } else {
      const prefix = `${caseSensitive ? rule.base : rule.base.toLowerCase()}/`
      if (!comparable.startsWith(prefix)) continue
      sub = relative.slice(rule.base.length + 1)
    }
    if (sub.length === 0) continue
    if (matchGlob(sub, rule.pattern, caseSensitive)) ignored = !rule.negate
  }
  return ignored
}
