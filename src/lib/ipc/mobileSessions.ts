import { listen } from '@tauri-apps/api/event'
import { isTauri, safeInvoke } from '../tauri'

/**
 * 电脑端「终端管理」读取手机会话。手机终端只归手机使用：
 * 这里只能列出、只读预览、重命名和结束，不提供输入、改尺寸或接管。
 */

export type MobileProjectKind = 'local' | 'wsl' | 'ssh'

export interface MobileSessionSummary {
  id: string
  number: number
  name: string
  /** 手动设置的名称；为空时 name 来自程序标题（原样保留，可能带转圈帧字符）。 */
  customName: string | null
  programTitle?: string | null
  /** 程序标题最近在转圈（后端按时间窗口平滑判断，旧版后端按当前标题判断）。 */
  programBusy: boolean
  exit: { exitCode: number; disconnected: boolean } | null
  lastActiveAt: number
  idleDeadline: number | null
  project: { id: string; name: string; path: string; kind: MobileProjectKind; host: string }
  deviceName: string | null
}

export interface MobileSessionPreview {
  name: string
  history: string[]
  screen: string
  cols: number
  rows: number
  alternate: boolean
  truncated: boolean
  exit: MobileSessionSummary['exit']
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseExit(value: unknown): MobileSessionSummary['exit'] {
  const exit = record(value)
  if (!exit) return null
  return {
    exitCode: typeof exit.exitCode === 'number' ? exit.exitCode : 0,
    disconnected: exit.disconnected === true,
  }
}

export function parseMobileSessionSummary(value: unknown): MobileSessionSummary | null {
  const item = record(value)
  const project = record(item?.project)
  if (!item || !project) return null
  if (typeof item.id !== 'string' || !item.id.startsWith('mobile-')) return null
  if (typeof project.id !== 'string' || typeof project.name !== 'string') return null
  const kind = project.kind === 'ssh' || project.kind === 'wsl' ? project.kind : 'local'
  const customName = typeof item.customName === 'string' && item.customName ? item.customName : null
  const title = typeof item.programTitle === 'string' ? item.programTitle : customName ? '' : item.name
  const exit = parseExit(item.exit)
  return {
    id: item.id,
    number: typeof item.number === 'number' ? item.number : 0,
    name: typeof item.name === 'string' && item.name ? item.name : `终端 ${item.number ?? ''}`.trim(),
    customName,
    programTitle: typeof item.programTitle === 'string' ? item.programTitle : null,
    programBusy: !exit && (typeof item.programBusy === 'boolean'
      ? item.programBusy
      : /^[\u2800-\u28ff\u25d0-\u25d3\u25e2-\u25e5\u25f0-\u25f7]/u.test(String(title ?? '').trim())),
    exit,
    lastActiveAt: typeof item.lastActiveAt === 'number' ? item.lastActiveAt : 0,
    idleDeadline: typeof item.idleDeadline === 'number' ? item.idleDeadline : null,
    project: {
      id: project.id,
      name: project.name,
      path: typeof project.path === 'string' ? project.path : '',
      kind,
      host: typeof project.host === 'string' ? project.host : '',
    },
    deviceName: typeof item.deviceName === 'string' && item.deviceName ? item.deviceName : null,
  }
}

export async function listMobileSessions(): Promise<MobileSessionSummary[]> {
  const result = await safeInvoke<unknown[]>('读取手机终端', 'mobile_sessions')
  return (Array.isArray(result) ? result : [])
    .map(parseMobileSessionSummary)
    .filter((item): item is MobileSessionSummary => item !== null)
}

export async function previewMobileSession(id: string): Promise<MobileSessionPreview> {
  const value = record(await safeInvoke<unknown>('预览手机终端', 'mobile_session_preview', { id })) ?? {}
  return {
    name: typeof value.name === 'string' ? value.name : '',
    history: Array.isArray(value.history) ? value.history.filter((line): line is string => typeof line === 'string') : [],
    screen: typeof value.screen === 'string' ? value.screen : '',
    cols: typeof value.cols === 'number' ? value.cols : 0,
    rows: typeof value.rows === 'number' ? value.rows : 0,
    alternate: value.alternate === true,
    truncated: value.truncated === true,
    exit: parseExit(value.exit),
  }
}

/** 监听某个手机终端的新输出。事件已由后端合并，只表示「有变化」，内容需再读取。 */
export async function listenMobileSessionOutput(id: string, onOutput: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen<{ id?: unknown }>('mobile-session-output', event => {
    if (event.payload?.id === id) onOutput()
  })
}

/**
 * 串行执行异步任务：运行中再次触发只记一次，结束后补跑一轮。
 * 既不会并发读取导致旧结果覆盖新结果，也不会漏掉最后一次变化。任务需自行处理错误。
 */
export function createCoalescedRunner(task: () => Promise<void>): () => void {
  let running = false
  let queued = false
  const run = () => {
    if (running) {
      queued = true
      return
    }
    running = true
    const done = () => {
      running = false
      if (queued) {
        queued = false
        run()
      }
    }
    void task().then(done, done)
  }
  return run
}

export function renameMobileSession(id: string, name: string): Promise<unknown> {
  return safeInvoke('重命名手机终端', 'mobile_rename_session', { id, name })
}

export function endMobileSession(id: string): Promise<void> {
  return safeInvoke('结束手机终端', 'mobile_end_session', { id })
}
