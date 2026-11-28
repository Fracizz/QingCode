import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import type { Stats } from 'node:fs'
import type { Readable } from 'node:stream'
import path from 'node:path'
import readline from 'node:readline'
import type { FsSearchResultEvt } from '@qn/protocol'
import { findSystemRg } from '../../rgPlugin'
import type { WorkspaceContext } from '../registry'
import { decodeText, detectTextEncoding, type TextEncoding } from './encoding'
import {
  MAX_IGNORE_FILE_BYTES,
  isIgnored,
  isSkippedDir,
  parseIgnore,
  type IgnoreRule,
} from './ignore'
import { readByteRange } from './io'
import {
  indexOfText,
  looksBinary,
  matchGlob,
  MAX_SEARCH_FILE_BYTES,
  nodeErrorCode,
  parseSearchId,
  parseSearchParams,
  truncateText,
  type ParsedSearch,
} from './logic'
import { cleanRelPath, parseRgMatch, SearchBatcher } from './searchLogic'

export interface SearchRunOptions {
  /** 测试钩子：绕过 rg 探测，强制走/不走 rg。 */
  rgAvailable?: boolean
}

interface ActiveSearch {
  abort(emitDone: boolean): void
}

interface SearchState {
  nextId: number
  active: Map<string, ActiveSearch>
}

interface SearchOutcome {
  truncated: boolean
  error?: string
  rgMissing?: boolean
}

type RgChild = ChildProcessByStdio<null, Readable, Readable>

interface SearchDeps {
  setChild(child: RgChild): void
  isCancelled(): boolean
  batcher: SearchBatcher
  ctx: WorkspaceContext
}

const EXCLUDE_GLOBS = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/.hg/**',
  '!**/.svn/**',
  '!**/$RECYCLE.BIN/**',
  '!**/System Volume Information/**',
]
const states = new WeakMap<WorkspaceContext, SearchState>()

function stateFor(ctx: WorkspaceContext): SearchState {
  const existing = states.get(ctx)
  if (existing) return existing
  const state: SearchState = { nextId: 0, active: new Map() }
  states.set(ctx, state)
  ctx.onClose(() => {
    for (const run of [...state.active.values()]) run.abort(false)
    state.active.clear()
  })
  return state
}

/** 探测结果进程内缓存，避免每次搜索都起一个 shell。 */
let rgProbe: ReturnType<typeof findSystemRg> | undefined

export function resetRgProbe(): void {
  rgProbe = undefined
}

async function resolveSystemRg(): Promise<string[]> {
  const command = (await (rgProbe ??= findSystemRg()))?.command
  return command ? [command] : []
}

export function startSearch(
  p: Record<string, unknown>,
  ctx: WorkspaceContext,
  options: SearchRunOptions = {},
): { searchId: string } {
  const params = parseSearchParams(p)
  const state = stateFor(ctx)
  const searchId = `fs-${ctx.clientId}-${++state.nextId}`
  const batcher = new SearchBatcher(searchId, params.maxResults, (evt: FsSearchResultEvt) => {
    ctx.emit('fs.searchResult', evt)
  })
  let finished = false
  let cancelled = false
  let child: RgChild | undefined

  const finish = (truncated: boolean, error?: string): void => {
    if (finished) return
    finished = true
    batcher.finish(truncated, error)
    state.active.delete(searchId)
  }
  const abort = (emitDone: boolean): void => {
    if (finished) return
    cancelled = true
    child?.kill()
    finished = true
    if (emitDone) batcher.finish(false)
    state.active.delete(searchId)
  }
  state.active.set(searchId, { abort })

  const deps: SearchDeps = {
    setChild(value) {
      child = value
      if (cancelled) child.kill()
    },
    isCancelled: () => cancelled || finished,
    batcher,
    ctx,
  }

  // 搜索在后台跑，方法本身立即返回 searchId。
  void (async () => {
    try {
      let rootStat: Stats
      try {
        // stat 跟随符号链接，项目根是链接时同样可搜。
        rootStat = await fsp.stat(params.root)
      } catch (err) {
        finish(false, `无法访问 root: ${describe(err)}`)
        return
      }
      const candidates = options.rgAvailable === false ? [] : await (ctx.resolveRg?.() ?? resolveSystemRg())
      for (const executable of candidates) {
        if (deps.isCancelled()) return
        const outcome = await runRgSearch(params, rootStat, deps, executable)
        if (!outcome.rgMissing) {
          finish(outcome.truncated, outcome.error)
          return
        }
      }
      const outcome = await runNodeSearch(params, rootStat, deps)
      finish(outcome.truncated, outcome.error)
    } catch (err) {
      finish(false, describe(err))
    }
  })()

  return { searchId }
}

export async function fsSearch(
  p: Record<string, unknown>,
  ctx: WorkspaceContext,
): Promise<{ searchId: string }> {
  return startSearch(p, ctx)
}

export async function fsSearchCancel(
  p: Record<string, unknown>,
  ctx: WorkspaceContext,
): Promise<Record<string, never>> {
  const searchId = parseSearchId(p)
  states.get(ctx)?.active.get(searchId)?.abort(true)
  return {}
}

function rgCommand(params: ParsedSearch, rootStat: Stats): { cwd: string; args: string[] } {
  const isDir = rootStat.isDirectory()
  const cwd = isDir ? params.root : path.dirname(params.root)
  const target = isDir ? '.' : path.basename(params.root)
  const args =
    params.mode === 'content'
      ? ['--json', '--fixed-strings', '--hidden', '--no-ignore']
      : ['--files', '--hidden', '--no-ignore']
  if (params.mode === 'content' && !params.caseSensitive) args.push('--ignore-case')
  for (const glob of EXCLUDE_GLOBS) args.push('--glob', glob)
  if (params.mode === 'content' && params.glob !== undefined) args.push('--glob', params.glob)
  if (params.mode === 'content') args.push('-e', params.query)
  args.push(target)
  return { cwd, args }
}

function globRelative(params: ParsedSearch, rootStat: Stats, absolute: string): string {
  return rootStat.isDirectory() ? path.relative(params.root, absolute) : path.basename(absolute)
}

async function runRgSearch(
  params: ParsedSearch,
  rootStat: Stats,
  deps: SearchDeps,
  executable: string,
): Promise<SearchOutcome> {
  const { cwd, args } = rgCommand(params, rootStat)
  let child: RgChild
  try {
    child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch {
    return { truncated: false, rgMissing: true }
  }
  deps.setChild(child)

  let spawnError: Error | undefined
  child.on('error', (err: Error) => {
    spawnError = err
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk
  })
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  let truncated = false
  let error: string | undefined
  let exitCode: number | null = null
  try {
    for await (const line of lines) {
      if (deps.isCancelled()) break
      if (params.mode === 'name') {
        const relative = cleanRelPath(line)
        if (relative.length === 0) continue
        const absolute = path.resolve(cwd, relative)
        if (params.glob !== undefined && !matchGlob(globRelative(params, rootStat, absolute), params.glob, params.caseSensitive)) {
          continue
        }
        if (indexOfText(path.basename(absolute), params.query, params.caseSensitive) < 0) continue
        if (deps.batcher.push({ path: absolute })) {
          truncated = true
          break
        }
      } else {
        const match = parseRgMatch(line, cwd)
        if (!match) continue
        if (params.glob !== undefined && !matchGlob(globRelative(params, rootStat, match.path), params.glob, params.caseSensitive)) {
          continue
        }
        if (deps.batcher.push(match)) {
          truncated = true
          break
        }
      }
    }
  } catch (err) {
    error = describe(err)
  } finally {
    if (truncated || deps.isCancelled() || error !== undefined) child.kill()
    exitCode = await waitClose(child)
    lines.close()
  }

  if (deps.isCancelled()) return { truncated: false }
  if (spawnError) return { truncated: false, rgMissing: true }
  if (exitCode !== null && exitCode > 1) {
    error = stderr.trim().slice(0, 2000) || `rg 退出码 ${exitCode}`
  }
  return { truncated, ...(error !== undefined ? { error } : {}) }
}

function waitClose(child: RgChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode)
  }
  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve(child.exitCode)
    }, 3000)
    child.once('close', (code: number | null) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

/** 无 rg 时的兜底：目录遍历跳过版本控制目录、大文件与二进制文件。 */
async function runNodeSearch(
  params: ParsedSearch,
  rootStat: Stats,
  deps: SearchDeps,
): Promise<SearchOutcome> {
  let truncated = false
  const isDir = rootStat.isDirectory()
  const relativeOf = (absolute: string): string =>
    isDir ? path.relative(params.root, absolute) : path.basename(absolute)

  const searchFile = async (absolute: string): Promise<boolean> => {
    if (params.glob !== undefined && !matchGlob(relativeOf(absolute), params.glob, params.caseSensitive)) {
      return false
    }
    if (params.mode === 'name') {
      if (indexOfText(path.basename(absolute), params.query, params.caseSensitive) < 0) return false
      if (deps.batcher.push({ path: absolute })) {
        truncated = true
        return true
      }
      return false
    }
    let chunk: Buffer
    try {
      const range = await readByteRange(absolute, 0, MAX_SEARCH_FILE_BYTES)
      if (range.size > MAX_SEARCH_FILE_BYTES || looksBinary(range.data)) return false
      chunk = range.data
    } catch {
      deps.ctx.log('fs.search 跳过不可读文件') // i18n-ignore: 仅进日志
      return false
    }
    const lines = chunk.toString('utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? ''
      const column = indexOfText(text, params.query, params.caseSensitive)
      if (column < 0) continue
      if (
        deps.batcher.push({
          path: absolute,
          line: i + 1,
          column: column + 1,
          text: truncateText(text),
        })
      ) {
        truncated = true
        return true
      }
    }
    return false
  }

  const walk = async (dir: string, inherited: readonly IgnoreRule[]): Promise<boolean> => {
    if (deps.isCancelled()) return true
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      deps.ctx.log('fs.search 跳过不可读目录') // i18n-ignore: 仅进日志
      return false
    }
    const rules = await loadIgnoreRules(dir, inherited, params, deps)
    for (const entry of entries) {
      if (deps.isCancelled()) return true
      const absolute = path.join(dir, entry.name)
      const relative = relativeOf(absolute)
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue
        if (isIgnored(relative, true, rules, params.caseSensitive)) continue
        if (await walk(absolute, rules)) return true
      } else if (entry.isFile()) {
        if (isIgnored(relative, false, rules, params.caseSensitive)) continue
        if (await searchFile(absolute)) return true
      }
      // 符号链接不跟随，避免循环与重复结果。
    }
    return false
  }

  if (rootStat.isFile()) {
    await searchFile(params.root)
  } else if (isDir) {
    await walk(params.root, [])
  } else {
    return { truncated: false, error: 'root 既不是文件也不是目录' }
  }
  return { truncated: deps.isCancelled() ? false : truncated }
}

/** 每进入一层目录追加该层的 .gitignore 规则；UTF-8/UTF-16 BOM 都能解析。 */
async function loadIgnoreRules(
  dir: string,
  inherited: readonly IgnoreRule[],
  params: ParsedSearch,
  deps: SearchDeps,
): Promise<IgnoreRule[]> {
  try {
    const range = await readByteRange(path.join(dir, '.gitignore'), 0, MAX_IGNORE_FILE_BYTES)
    const detected = detectTextEncoding(range.data)
    const info: TextEncoding = detected ?? { encoding: 'utf8', bom: false, bomBytes: 0 }
    const { content } = decodeText(range.data, info, info.bom)
    const base = cleanRelPath(path.relative(params.root, dir))
    return [...inherited, ...parseIgnore(content, base)]
  } catch (err) {
    // 大多数目录没有 .gitignore，ENOENT 属于正常情况，不刷日志。
    if (nodeErrorCode(err) !== 'ENOENT') deps.ctx.log('fs.search 跳过不可读的 .gitignore') // i18n-ignore: 仅进日志
    return [...inherited]
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
