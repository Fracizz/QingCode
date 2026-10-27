export type TestEntry = { directory: boolean; content: string; mtime: number }
export type TestEntries = Record<string, TestEntry>
export type FsChange = { path: string; kind: string; isDir: boolean }

export function normalizeTestPath(path: string): string {
  if (!path.startsWith('/') && !/^ssh:\/\/[^/]+\//.test(path)) {
    throw new Error('Web test filesystem requires an absolute POSIX or SSH resource path')
  }
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some(part => part === '..' || part === '.')
  ) {
    throw new Error('Invalid test filesystem path')
  }
  return path.replace(/\/+$/, '') || '/'
}

export function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

export function testParent(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

/** Text-only virtual disk; all commands and injected external writes share this state. */
export class WebTestFileSystem {
  constructor(
    readonly entries: TestEntries,
    private readonly persist: () => void,
    private readonly notify: (change: FsChange) => void
  ) {}

  get(path: string): TestEntry {
    const entry = this.entries[normalizeTestPath(path)]
    if (!entry) throw new Error(`路径不存在：${path}`)
    return entry
  }

  read(path: string): string {
    const entry = this.get(path)
    if (entry.directory) throw new Error(`不能读取目录：${path}`)
    return entry.content
  }

  list(path: string) {
    if (!this.get(path).directory) throw new Error(`目录不可用：${path}`)
    return Object.entries(this.entries)
      .filter(([key]) => key !== path && testParent(key) === path)
      .map(([key, entry]) => ({
        name: key.slice(key.lastIndexOf('/') + 1),
        path: key,
        is_dir: entry.directory,
      }))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
  }

  write(path: string, content: string, createOnly = false, directory = false): void {
    path = normalizeTestPath(path)
    if (createOnly && this.entries[path]) throw new Error('目标名称已存在')
    if (this.entries[path]?.directory && !directory) throw new Error('不能覆盖目录')
    if (!this.get(testParent(path)).directory) throw new Error('父目录不可用')
    const previous = this.entries[path]
    this.entries[path] = {
      directory,
      content,
      mtime: Math.max(Date.now(), (previous?.mtime ?? 0) + 1),
    }
    try {
      this.persist()
    } catch (error) {
      if (previous) this.entries[path] = previous
      else delete this.entries[path]
      throw error
    }
    this.notify({ path, kind: previous ? 'modify' : 'create', isDir: directory })
  }

  remove(path: string): void {
    path = normalizeTestPath(path)
    const entry = this.get(path)
    const previous = { ...this.entries }
    Object.keys(this.entries)
      .filter(key => pathWithin(key, path))
      .forEach(key => delete this.entries[key])
    this.persistOrRestore(previous)
    this.notify({ path, kind: 'remove', isDir: entry.directory })
  }

  relocate(source: string, target: string, copy = false): string {
    source = normalizeTestPath(source)
    target = normalizeTestPath(target)
    const entry = this.get(source)
    if (this.entries[target]) throw new Error('目标名称已存在')
    if (pathWithin(target, source)) throw new Error('不能移到自身目录内')
    if (!this.get(testParent(target)).directory) throw new Error('目标目录不可用')
    const previous = { ...this.entries }
    for (const [key, value] of Object.entries(this.entries)) {
      if (!pathWithin(key, source)) continue
      this.entries[target + key.slice(source.length)] = { ...value, mtime: Date.now() }
      if (!copy) delete this.entries[key]
    }
    this.persistOrRestore(previous)
    if (!copy) this.notify({ path: source, kind: 'remove', isDir: entry.directory })
    this.notify({ path: target, kind: 'create', isDir: entry.directory })
    return target
  }

  private persistOrRestore(previous: TestEntries) {
    try {
      this.persist()
    } catch (error) {
      Object.keys(this.entries).forEach(key => delete this.entries[key])
      Object.assign(this.entries, previous)
      throw error
    }
  }
}
