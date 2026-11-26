// 浏览器实测手机版用：注入一个假的 window.QnNative，把 probe/pair/rpc/events 经本地 vite 中间件
// 转成对电脑手机网关的 HTTPS 请求（按指纹校验，等同 Android PinnedHttps）。仅本地调试，不进 APK。
import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import base from './vite.config'

type Params = Record<string, unknown>

function gatewayFetch(params: Params, path: string, body: unknown, token?: string, stream = false) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const expected = String(params.fp ?? '').toLowerCase()
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = httpsRequest({
      host: String(params.host), port: Number(params.port), path, method: payload ? 'POST' : 'GET',
      rejectUnauthorized: false, agent: false,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      timeout: stream ? 0 : 40_000,
    }, (res) => {
      const raw = (res.socket as TLSSocket).getPeerCertificate().raw
      const fp = raw ? createHash('sha256').update(raw).digest('hex') : ''
      ;(res as IncomingMessage & { fp?: string }).fp = fp
      if (expected && fp !== expected) {
        res.destroy()
        reject(Object.assign(new Error('证书指纹不一致'), { code: 'fingerprint' }))
        return
      }
      resolve(res)
    })
    req.on('error', (e) => reject(Object.assign(e, { code: 'network' })))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

async function readJson(res: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of res) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

function unwrap(status: number, data: unknown): unknown {
  const obj = data as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } | string } | null
  if (status >= 200 && status < 300 && obj?.ok !== false) return obj && 'ok' in obj && 'result' in obj ? obj.result : obj
  const err = obj?.error
  const message = typeof err === 'string' ? err : err?.message ?? `HTTP ${status}`
  throw Object.assign(new Error(message), { code: typeof err === 'object' ? err?.code ?? 'internal' : 'internal' })
}

async function dispatch(method: string, p: Params): Promise<unknown> {
  if (method === 'probe') {
    const res = await gatewayFetch({ ...p, fp: '' }, '/probe', undefined)
    const fp = (res as IncomingMessage & { fp?: string }).fp
    const info = unwrap(res.statusCode ?? 0, await readJson(res)) as Params
    return { ...info, fingerprint: fp }
  }
  if (method === 'pair') {
    const res = await gatewayFetch(p, '/pair', { code: p.code, deviceName: p.deviceName || '浏览器实测' })
    const data = unwrap(res.statusCode ?? 0, await readJson(res)) as Params
    return { token: data.token, desktopName: data.desktopName ?? data.name ?? '' }
  }
  if (method === 'rpc') {
    const inner = (p.params ?? {}) as Params
    const body: Params = { method: p.method, params: inner }
    const agent = p.agent ?? inner.agent
    if (agent != null) body.agent = agent
    const res = await gatewayFetch(p, '/rpc', body, String(p.token))
    return unwrap(res.statusCode ?? 0, await readJson(res))
  }
  throw Object.assign(new Error('不支持的原生方法'), { code: 'unsupported' })
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Params
}

const devNative = (): Plugin => ({
  name: 'qn-dev-native',
  apply: 'serve',
  transformIndexHtml: () => [{ tag: 'script', attrs: { src: '/__qn/shim.js' }, injectTo: 'head-prepend' }],
  configureServer(server) {
    server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
      const url = req.url ?? ''
      if (url === '/__qn/shim.js') {
        res.setHeader('content-type', 'text/javascript')
        res.end(SHIM)
        return
      }
      if (url === '/__qn/native' && req.method === 'POST') {
        const { method, params } = await readBody(req)
        res.setHeader('content-type', 'application/json')
        try {
          const result = await dispatch(String(method), (params ?? {}) as Params)
          res.end(JSON.stringify({ ok: true, result }))
        } catch (e) {
          const err = e as Error & { code?: string }
          res.end(JSON.stringify({ ok: false, error: err.message, code: err.code ?? 'internal' }))
        }
        return
      }
      if (url === '/__qn/events' && req.method === 'POST') {
        const params = await readBody(req)
        try {
          const up = await gatewayFetch(params, '/events', undefined, String(params.token), true)
          if ((up.statusCode ?? 0) >= 300) {
            res.statusCode = up.statusCode ?? 502
            res.end(JSON.stringify(await readJson(up)))
            return
          }
          res.setHeader('content-type', 'application/x-ndjson')
          up.pipe(res)
          req.on('close', () => up.destroy())
          res.on('close', () => up.destroy())
        } catch (e) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
        return
      }
      next()
    })
  },
})

// 浏览器侧：同步返回 ack，异步经 __qnNativeCallback 回包；storage 落 localStorage。
const SHIM = `(() => {
  const cb = (m) => setTimeout(() => window.__qnNativeCallback && window.__qnNativeCallback(JSON.stringify(m)))
  const streams = new Map(); let seq = 0
  async function openStream(id, p) {
    const sid = 'b' + (++seq); const ctl = new AbortController(); streams.set(sid, ctl)
    let res
    try { res = await fetch('/__qn/events', { method: 'POST', body: JSON.stringify(p), signal: ctl.signal }) }
    catch (e) { streams.delete(sid); return cb({ id, ok: false, error: '无法连接电脑', code: 'network' }) }
    if (!res.ok) { streams.delete(sid); return cb({ id, ok: false, error: await res.text(), code: 'network' }) }
    cb({ id, ok: true, result: sid })
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true }); let i
        while ((i = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
          if (line) try { cb({ stream: sid, event: JSON.parse(line) }) } catch {}
        }
      }
      if (streams.delete(sid)) cb({ stream: sid, closed: true, error: '事件流已断开' })
    } catch (e) { if (streams.delete(sid)) cb({ stream: sid, closed: true, error: '事件流已断开' }) }
  }
  window.QnNative = { request(json) {
    const { id, method, params = {} } = JSON.parse(json)
    if (method === 'storage.get') cb({ id, ok: true, result: localStorage.getItem('qn:' + params.key) })
    else if (method === 'storage.set') { params.value == null ? localStorage.removeItem('qn:' + params.key) : localStorage.setItem('qn:' + params.key, typeof params.value === 'string' ? params.value : JSON.stringify(params.value)); cb({ id, ok: true, result: { ok: true } }) }
    else if (method === 'clipboard.read') cb({ id, ok: true, result: localStorage.getItem('qn:__clipboard') || '' })
    else if (method === 'clipboard.write') cb({ id, ok: true, result: { ok: true } })
    else if (method === 'pair.pending') cb({ id, ok: true, result: null })
    else if (method === 'updates.status') cb({ id, ok: true, result: null })
    else if (method === 'events.open') openStream(id, params)
    else if (method === 'events.close') { const s = streams.get(String(params.stream)); streams.delete(String(params.stream)); s && s.abort(); cb({ id, ok: true, result: { closed: true } }) }
    else fetch('/__qn/native', { method: 'POST', body: JSON.stringify({ method, params }) })
      .then((r) => r.json()).then((r) => cb({ id, ...r })).catch((e) => cb({ id, ok: false, error: String(e), code: 'network' }))
    return JSON.stringify({ id, queued: true })
  } }
})()`

export default mergeConfig(base, defineConfig({
  plugins: [devNative()],
  server: { host: '127.0.0.1', port: 5181, strictPort: true },
}))
