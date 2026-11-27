import type { FsEntry } from '@qn/protocol'
import { BackendCallError, call } from '../../lib/backend'
import { serverCall } from '../workspace/serverCall'
import {
  discoverCargo,
  discoverMakeTargets,
  discoverPackageScripts,
  discoverPython,
  joinPath,
  parseRunConfigFile,
  runConfigPaths,
  serializeRunConfigFile,
  type DiscoveredTask,
  type DiscoveryWarning,
  type PackageManager,
  type RunConfigFile,
} from './runConfigModel'
import type { RunOs } from './types'

// 运行配置文件的读写与项目扫描（IO）；解析与发现规则都在 runConfigModel.ts。

export type LoadedRunConfigs = {
  file: RunConfigFile
  /** 实际读到的文件；none 表示两处都不存在 */
  source: 'qingcode' | 'nestcode' | 'none'
  /** 读到 .qingcode/run.json 时的 mtime，保存时用于冲突检测 */
  mtimeMs?: number
  /** 文件存在但格式错误：此时禁止保存，避免覆盖用户文件 */
  error?: string
}

const MANIFEST_LIMIT = 256 * 1024
const MAX_CHILD_DIRS = 32
const IGNORED_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage'])

function isNotFound(err: unknown): boolean {
  return err instanceof BackendCallError && err.code === 'not_found'
}

async function readText(targetId: string, path: string, limit?: number): Promise<{ content: string; mtimeMs: number }> {
  const result = await serverCall(targetId, 'fs.read', { path, ...(limit ? { length: limit } : {}) })
  if (result.binary) throw new Error(`${path} 不是文本文件`)
  if (result.truncated) throw new Error(`${path} 过大`)
  return { content: result.content, mtimeMs: result.mtimeMs }
}

/** 读 `.qingcode/run.json`，不存在时只读回退 `.nestcode/run.json`（旧产品名）。 */
export async function loadRunConfigs(targetId: string, root: string): Promise<LoadedRunConfigs> {
  const paths = runConfigPaths(root)
  for (const [source, path] of [
    ['qingcode', paths.file],
    ['nestcode', paths.legacyFile],
  ] as const) {
    let text: { content: string; mtimeMs: number }
    try {
      text = await readText(targetId, path)
    } catch (err) {
      if (isNotFound(err)) continue
      throw err
    }
    const parsed = parseRunConfigFile(text.content)
    const loaded: LoadedRunConfigs = parsed.ok
      ? { file: parsed.file, source }
      : { file: { configs: [] }, source, error: `${source === 'qingcode' ? '.qingcode' : '.nestcode'}/run.json 格式错误：${parsed.error}` }
    if (source === 'qingcode') loaded.mtimeMs = text.mtimeMs
    return loaded
  }
  return { file: { configs: [] }, source: 'none' }
}

/**
 * 原子写 `.qingcode/run.json`（fs.write 先写临时文件再 rename）。
 * expectedMtimeMs 不符时 server 返回 conflict，调用方应重新加载。
 */
export async function saveRunConfigs(
  targetId: string,
  root: string,
  file: RunConfigFile,
  expectedMtimeMs?: number,
): Promise<number> {
  const paths = runConfigPaths(root)
  await serverCall(targetId, 'fs.mkdir', { path: paths.dir })
  const result = await serverCall(targetId, 'fs.write', {
    path: paths.file,
    content: serializeRunConfigFile(file),
    ...(expectedMtimeMs !== undefined ? { expectedMtimeMs } : {}),
  })
  return result.mtimeMs
}

async function listDir(targetId: string, path: string): Promise<FsEntry[]> {
  // fs.list 不在 WorkspaceMethods 里，与文件树一致直接透传 backend。
  const result = (await call('server.req', { targetId, method: 'fs.list', params: { path } })) as { entries?: FsEntry[] }
  return Array.isArray(result?.entries) ? result.entries : []
}

export type DiscoveryResult = { tasks: DiscoveredTask[]; warnings: DiscoveryWarning[] }

/** 只读扫描项目根与一层子目录；不执行任何命令、不写文件。 */
export async function discoverProject(targetId: string, root: string, os: RunOs): Promise<DiscoveryResult> {
  const tasks: DiscoveredTask[] = []
  const warnings: DiscoveryWarning[] = []
  const warn = (source: string, err: unknown): void => {
    warnings.push({ source, message: err instanceof Error ? err.message : String(err) })
  }
  const rootEntries = await listDir(targetId, root)
  const fileNames = rootEntries.filter((e) => e.kind !== 'dir').map((e) => e.name)
  const allNames = rootEntries.map((e) => e.name)
  const has = (name: string): boolean => fileNames.includes(name)

  let inherited: PackageManager | null = null
  const visitPackage = async (dir: string, cwd: string, names: string[]): Promise<void> => {
    if (!names.includes('package.json')) return
    const source = cwd ? `${cwd}/package.json` : 'package.json'
    try {
      const { content } = await readText(targetId, joinPath(dir, 'package.json'), MANIFEST_LIMIT)
      const found = discoverPackageScripts(content, { cwd, fileNames: names, inherited })
      if (!cwd) inherited = found.manager
      tasks.push(...found.tasks)
      warnings.push(...found.warnings)
    } catch (err) {
      warn(source, err)
    }
  }

  await visitPackage(root, '', fileNames)
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    if (!has(name)) continue
    try {
      tasks.push(...discoverMakeTargets((await readText(targetId, joinPath(root, name), MANIFEST_LIMIT)).content, name))
    } catch (err) {
      warn(name, err)
    }
    break
  }
  if (has('Cargo.toml')) {
    try {
      tasks.push(...discoverCargo((await readText(targetId, joinPath(root, 'Cargo.toml'), MANIFEST_LIMIT)).content))
    } catch (err) {
      warn('Cargo.toml', err)
    }
  }
  let pyproject: string | null = null
  if (has('pyproject.toml')) {
    try {
      pyproject = (await readText(targetId, joinPath(root, 'pyproject.toml'), MANIFEST_LIMIT)).content
    } catch (err) {
      warn('pyproject.toml', err)
    }
  }
  tasks.push(...discoverPython({ fileNames: allNames, pyproject, os }))

  const dirs = rootEntries
    .filter((e) => e.kind === 'dir' && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (dirs.length > MAX_CHILD_DIRS) warnings.push({ source: '.', message: `只扫描前 ${MAX_CHILD_DIRS} 个子目录` })
  // 逐个扫描：SSH 目标上并发几十个请求会拖慢对话。
  for (const entry of dirs.slice(0, MAX_CHILD_DIRS)) {
    const dir = joinPath(root, entry.name)
    try {
      const names = (await listDir(targetId, dir)).filter((e) => e.kind !== 'dir').map((e) => e.name)
      await visitPackage(dir, entry.name, names)
    } catch (err) {
      warn(entry.name, err)
    }
  }
  return { tasks, warnings }
}
