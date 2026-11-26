/**
 * 服务端直连真机验收：连接码 → TLS 指纹固定 → ping → fs.home → 指定 agent 跑一轮对话。
 *
 * 远端先运行：node qn-server.cjs serve --listen 0.0.0.0:47390   （stdout 打印连接码）
 * 仓库根执行：
 *   pnpm exec esbuild apps/desktop/src/backend/dev/smoke-direct.ts --bundle --platform=node --format=esm --external:ssh2 --external:cpu-features --outfile=apps/desktop/.dev/smoke-direct.mjs
 *   QN_DIRECT_CODE=<连接码> node apps/desktop/.dev/smoke-direct.mjs [--host H] [--agent claude|codex] [--cwd 目录] [--prompt 文本]
 * 连接码含 token，只经环境变量传入，不打印。审批请求一律拒绝（验证审批链路，不让 agent 改动文件）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeDirectCode } from '@qn/protocol'
import type { AgentKind, DirectTarget } from '../../shared/backendApi'
import { TargetManager } from '../targets'

export interface DirectSmokeArgs {
  code: string
  host?: string
  agent: AgentKind
  cwd?: string
  prompt: string
  timeoutMs: number
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export function parseDirectSmokeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DirectSmokeArgs {
  const opts = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key?.startsWith('--') && value !== undefined) {
      opts.set(key.slice(2), value)
      i++
    }
  }
  const code = env['QN_DIRECT_CODE'] ?? ''
  if (!code) throw new Error('需要环境变量 QN_DIRECT_CODE（serve 打印的连接码）')
  const agent = opts.get('agent') === 'codex' ? 'codex' : 'claude'
  return {
    code,
    ...(opts.has('host') ? { host: opts.get('host')! } : {}),
    agent,
    ...(opts.has('cwd') ? { cwd: opts.get('cwd')! } : {}),
    prompt: opts.get('prompt') ?? '列出当前目录的顶层文件和目录，并用一句话说明这个项目是做什么的。不要修改任何文件。',
    timeoutMs: Number(opts.get('timeout') ?? 240_000),
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export async function runDirectSmoke(args: DirectSmokeArgs): Promise<void> {
  const info = decodeDirectCode(args.code)
  if (!info) throw new Error('连接码无效')
  const host = args.host ?? info.hosts[0]
  if (!host) throw new Error('连接码没有可用地址，请用 --host 指定')
  const target: DirectTarget = {
    id: `smoke-direct-${host}-${String(info.port)}`,
    kind: 'direct',
    name: info.name ?? host,
    host,
    port: info.port,
    fingerprint: info.fingerprint,
  }
  const userData = await mkdtemp(join(tmpdir(), 'qn-smoke-direct-'))
  const pending = new Map<number, Pending>()
  let nextId = 1
  let turnDone: ((status: string) => void) | null = null
  const counts = new Map<string, number>()
  let agentText = ''

  const manager = new TargetManager({
    userData,
    resourcesPath: '',
    electronPath: '',
    appVersion: 'smoke',
    loadSecret: async () => ({ token: info.token }),
    saveSecret: async () => undefined,
    emit: (name, payload) => {
      if (name === 'target.state') {
        const s = payload as { state: string; detail?: string }
        console.log(`[target.state] ${s.state}${s.detail ? ` ${s.detail}` : ''}`)
        return
      }
      if (name !== 'codex.recv' || !isRecord(payload)) return
      const msg = payload['msg']
      if (!isRecord(msg)) return
      // 响应
      if (typeof msg['id'] === 'number' && !('method' in msg)) {
        const p = pending.get(msg['id'])
        if (!p) return
        pending.delete(msg['id'])
        if (isRecord(msg['error'])) p.reject(new Error(String(msg['error']['message'] ?? 'rpc error')))
        else p.resolve(msg['result'])
        return
      }
      const method = typeof msg['method'] === 'string' ? msg['method'] : ''
      counts.set(method, (counts.get(method) ?? 0) + 1)
      const params = isRecord(msg['params']) ? msg['params'] : {}
      // server → client 请求（审批等）：一律拒绝。
      if ('id' in msg && msg['id'] !== null && method) {
        console.log(`[server request] ${method} → decline`)
        manager.codexSend(target.id, { jsonrpc: '2.0', id: msg['id'], result: { decision: 'decline' } }, args.agent)
        return
      }
      if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') agentText += params['delta']
      if (method === 'item/started' || method === 'item/completed') {
        const item = isRecord(params['item']) ? params['item'] : {}
        const detail = item['type'] === 'commandExecution' ? ` ${String(item['command'] ?? '')}` : ''
        console.log(`[${method}] seq=${String(payload['seq'])} id=${String(item['id'] ?? '?')} ${String(item['type'] ?? '?')}${detail}`)
      }
      if (method === 'turn/completed') {
        const turn = isRecord(params['turn']) ? params['turn'] : {}
        turnDone?.(String(turn['status'] ?? 'completed'))
      }
      if (method === 'error') console.log(`[error] ${JSON.stringify(params).slice(0, 300)}`)
    },
  })

  const rpc = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      manager.codexSend(target.id, { jsonrpc: '2.0', id, method, params }, args.agent)
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`))
      }, 60_000).unref()
    })
  }

  const started = Date.now()
  try {
    await manager.connect(target, {})
    await manager.waitUntilReady(target.id, 30_000)
    const ping = await manager.request(target.id, 'ping')
    const home = await manager.request(target.id, 'fs.home')
    console.log(`[ping] ${JSON.stringify(ping)}  [home] ${JSON.stringify(home)}  (${String(Date.now() - started)}ms)`)
    const cwd = args.cwd ?? (isRecord(home) ? String(home['path']) : '')
    const list = await manager.request(target.id, 'fs.list', { path: cwd })
    console.log(`[fs.list] ${cwd}: ${isRecord(list) && Array.isArray(list['entries']) ? list['entries'].length : '?'} 项`)

    // 文件/Git 协议顺带验收（方法不存在时只提示，不算失败）。
    for (const [method, params] of [
      ['git.status', { cwd }],
      ['fs.read', { path: `${cwd}${cwd.includes('/') ? '/' : '\\'}README.md`, length: 200 }],
    ] as const) {
      try {
        const r = await manager.request(target.id, method, params)
        const brief = isRecord(r)
          ? method === 'git.status'
            ? `branch=${String(r['branch'])} files=${Array.isArray(r['files']) ? r['files'].length : '?'} ahead=${String(r['ahead'])}`
            : `size=${String(r['size'])} truncated=${String(r['truncated'])} 首行=${String(r['content']).split('\n')[0] ?? ''}`
          : String(r)
        console.log(`[${method}] ${brief}`)
      } catch (err) {
        console.log(`[${method}] 失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const opened = await manager.request(target.id, 'codex.open', { agent: args.agent })
    const agentVersion = isRecord(opened) ? opened['agentVersion'] ?? opened['codexVersion'] : undefined
    console.log(`[codex.open] agent=${args.agent} version=${String(agentVersion)}`)
    await manager.request(target.id, 'codex.attach', { agent: args.agent, sinceSeq: isRecord(opened) ? opened['lastSeq'] : 0 })

    const thread = await rpc('thread/start', { cwd })
    const threadId = isRecord(thread) && isRecord(thread['thread']) ? String(thread['thread']['id']) : ''
    if (!threadId) throw new Error(`thread/start 未返回 id: ${JSON.stringify(thread).slice(0, 200)}`)
    console.log(`[thread/start] ${threadId}`)

    const turnStarted = Date.now()
    const done = new Promise<string>((resolve, reject) => {
      turnDone = resolve
      setTimeout(() => reject(new Error('turn 超时')), args.timeoutMs).unref()
    })
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: args.prompt, text_elements: [] }] })
    const status = await done
    console.log(`[turn/completed] status=${status} 用时 ${String(Math.round((Date.now() - turnStarted) / 1000))}s`)
    console.log(`[通知统计] ${JSON.stringify(Object.fromEntries(counts))}`)
    console.log(`[agent 回复]\n${agentText.trim().slice(0, 2000)}`)

    const listed = await rpc('thread/list', { cwd })
    const found = isRecord(listed) && Array.isArray(listed['data'])
      ? listed['data'].some((t) => isRecord(t) && t['id'] === threadId)
      : false
    console.log(`[thread/list] 新会话${found ? '已' : '未'}出现在列表中`)
    if (status !== 'completed') throw new Error(`turn 状态 ${status}`)
  } finally {
    manager.shutdown()
    await rm(userData, { recursive: true, force: true })
  }
}

function isMain(): boolean {
  return /(?:^|[\\/])smoke-direct\.(?:mjs|js|cjs|ts)$/.test(process.argv[1] ?? '')
}

if (isMain()) {
  try {
    const args = parseDirectSmokeArgs(process.argv.slice(2))
    void runDirectSmoke(args).then(
      () => console.log('直连 smoke 通过'),
      (err: unknown) => {
        console.error(`直连 smoke 失败：${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      },
    )
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
