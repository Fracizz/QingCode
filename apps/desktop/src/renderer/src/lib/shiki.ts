import type { LanguageRegistration, ThemeRegistrationAny } from 'shiki/core'
import { CODE_THEMES } from './highlight'
import type { HighlightTokens } from './shikiCore'

// shiki 只在第一次遇到代码块时按需加载：主题和用到的语言语法各自是独立 chunk，不拖慢启动。
// 着色本身是同步的正则匹配，大代码块或回溯严重的语法会占用数秒，因此放进 Worker；
// 主线程只按需加载语法对象并转交，Worker 产物里只有 shiki 核心。

export type HighlightRequest = {
  id: number
  code: string
  lang: string
  /** 该语言第一次发给当前 Worker 时附带语法。 */
  grammars?: LanguageRegistration[]
  /** Worker 的第一条请求附带主题。 */
  themes?: ThemeRegistrationAny[]
}

export type HighlightResponse = { id: number; tokens: HighlightTokens | null }

/** Worker 持续这么久没有任何响应视为卡死（语法正则回溯），终止重建，未完成的块按纯文本显示。 */
const WORKER_STALL_MS = 4_000
/** Worker 不可用时只在主线程高亮小代码块，避免大块阻塞界面。 */
export const MAIN_THREAD_MAX_CHARS = 8_000
const CACHE_LIMIT = 200

let themes: Promise<ThemeRegistrationAny[]> | null = null
const loadThemes = (): Promise<ThemeRegistrationAny[]> => themes ??= (async () => {
  const { bundledThemes } = await import('shiki/themes')
  const loaded = await Promise.all([bundledThemes[CODE_THEMES.dark](), bundledThemes[CODE_THEMES.light]()])
  return loaded.map((module) => module.default)
})()

type GrammarLoader = () => Promise<{ default: LanguageRegistration[] }>
const grammars = new Map<string, Promise<LanguageRegistration[] | null>>()
const loadGrammar = (lang: string): Promise<LanguageRegistration[] | null> => {
  let pending = grammars.get(lang)
  if (!pending) {
    pending = (async () => {
      try {
        const { bundledLanguages } = await import('shiki/langs')
        const loader = (bundledLanguages as Record<string, GrammarLoader | undefined>)[lang]
        return loader ? (await loader()).default : null
      } catch {
        return null
      }
    })()
    grammars.set(lang, pending)
  }
  return pending
}

type WorkerClient = {
  worker: Worker
  sentThemes: boolean
  sentLangs: Set<string>
  pending: Map<number, (tokens: HighlightTokens | null) => void>
  stall: ReturnType<typeof setTimeout> | null
}

let client: WorkerClient | null = null
let workerBroken = false
let nextId = 0

function dropWorker(target: WorkerClient): void {
  if (client === target) client = null
  if (target.stall !== null) clearTimeout(target.stall)
  target.stall = null
  target.worker.terminate()
  for (const resolve of target.pending.values()) resolve(null)
  target.pending.clear()
}

/** 有未完成请求时开始计时，每收到一个响应重新计时。 */
function armStall(target: WorkerClient): void {
  if (target.stall !== null) clearTimeout(target.stall)
  target.stall = target.pending.size > 0 ? setTimeout(() => dropWorker(target), WORKER_STALL_MS) : null
}

function getClient(): WorkerClient | null {
  if (client || workerBroken || typeof Worker === 'undefined') return client
  try {
    const worker = new Worker(new URL('./shiki.worker.ts', import.meta.url), { type: 'module' })
    const created: WorkerClient = { worker, sentThemes: false, sentLangs: new Set(), pending: new Map(), stall: null }
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      const resolve = created.pending.get(event.data.id)
      created.pending.delete(event.data.id)
      armStall(created)
      resolve?.(event.data.tokens)
    }
    worker.onerror = () => {
      // 脚本加载或执行失败：之后都走主线程兜底（只高亮小块）。
      workerBroken = true
      dropWorker(created)
    }
    client = created
  } catch {
    workerBroken = true
  }
  return client
}

async function highlightInWorker(target: WorkerClient, code: string, lang: string): Promise<HighlightTokens | null> {
  const [loadedThemes, grammar] = await Promise.all([
    target.sentThemes ? null : loadThemes(),
    target.sentLangs.has(lang) ? null : loadGrammar(lang),
  ])
  // 等语法期间 Worker 被重建或判定不可用，换到当前通道重新发。
  if (client !== target) return highlightUncached(code, lang)
  if (!target.sentLangs.has(lang) && !grammar) return null
  const request: HighlightRequest = { id: ++nextId, code, lang }
  if (!target.sentThemes && loadedThemes) {
    request.themes = loadedThemes
    target.sentThemes = true
  }
  if (!target.sentLangs.has(lang) && grammar) {
    request.grammars = grammar
    target.sentLangs.add(lang)
  }
  return new Promise((resolve) => {
    target.pending.set(request.id, resolve)
    if (target.stall === null) armStall(target)
    target.worker.postMessage(request)
  })
}

let fallback: Promise<{ tokenize: (code: string, lang: string, grammars?: LanguageRegistration[]) => Promise<HighlightTokens | null> }> | null = null
async function highlightOnMainThread(code: string, lang: string): Promise<HighlightTokens | null> {
  if (code.length > MAIN_THREAD_MAX_CHARS) return null
  const grammar = await loadGrammar(lang)
  if (!grammar) return null
  fallback ??= Promise.all([import('./shikiCore'), loadThemes()]).then(([core, loaded]) => core.createTokenizer(loaded))
  return (await fallback).tokenize(code, lang, grammar)
}

function highlightUncached(code: string, lang: string): Promise<HighlightTokens | null> {
  const target = getClient()
  return target ? highlightInWorker(target, code, lang) : highlightOnMainThread(code, lang)
}

// 同一段代码（切换会话再切回、消息重渲染）直接复用结果，进行中的请求也合并。
const cache = new Map<string, Promise<HighlightTokens | null>>()

/** 返回按行分组的着色 token（每个 token 带 dark/light 两套样式）；语言不在 shiki 内置列表、超时或失败时返回 null（调用方按纯文本显示）。 */
export function highlightTokens(code: string, lang: string): Promise<HighlightTokens | null> {
  const key = `${lang}\u0000${code}`
  const hit = cache.get(key)
  if (hit) {
    // 重新插入，维持 LRU 顺序。
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const result = highlightUncached(code, lang)
  cache.set(key, result)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return result
}
