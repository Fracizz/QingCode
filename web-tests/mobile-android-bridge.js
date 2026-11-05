// QingCode Android Web 验收：在浏览器中替代 MainActivity 的 JS 桥与 Windows 端 RPC。
// 只用于 vite.web-test.config.ts 提供的 /mobile-android/ 页面；数据全部在内存中。
(() => {
  const FINGERPRINT = '0123456789abcdef'.repeat(4)
  const CODE = 'A8z2D3'
  const encoder = new TextEncoder()
  const base64 = text => btoa(String.fromCharCode(...encoder.encode(text)))
  const state = {
    profiles: new Map(),
    // host:port → fingerprint presented by that "computer".
    hosts: new Map([['192.168.1.8:48764', FINGERPRINT], ['192.168.1.8:49000', FINGERPRINT], ['10.0.0.9:48764', 'f'.repeat(64)]]),
    projects: [
      { id: 'p-local', name: 'QingCode', path: 'D:\\code\\qingcode', kind: 'local', host: 'Windows' },
      { id: 'p-ssh', name: 'api-server', path: 'ssh://conn-1/srv/api', kind: 'ssh', host: 'build.example' },
    ],
    sessions: new Map(),
    // 电脑端「终端配置」；null 模拟不支持 terminal_profiles 的旧版电脑端。
    terminalProfiles: [
      { id: 'default', name: '普通终端', trusted: true },
      { id: 'claude', name: 'Claude', trusted: true },
      { id: 'opencode', name: 'OpenCode', trusted: true },
      { id: 'deploy', name: '部署', trusted: false },
    ],
    creates: [],
    terminalProfileRequests: 0,
    capabilities: { protocolVersion: 1, features: ['terminal_profiles', 'session_names', 'images', 'latest_screen', 'history'], sessionScope: 'shared' },
    capabilityRequests: 0,
    sessionNames: true,
    renameError: null,
    renameDelay: 0,
    ends: [],
    endErrors: new Set(),
    inputs: [],
    inputEvents: [],
    inputGate: null,
    inputDelay: 0,
    inputError: null,
    polls: [],
    sessionRequests: [],
    sessionDelay: 0,
    sessionError: null,
    historyRequests: [],
    pairs: [],
    clipboard: '',
    openedLinks: [],
    latency: 32.4,
    latencySupported: true,
    latencyRequests: [],
    latencyError: null,
    latencyDelay: 0,
    fullscreen: false,
    fullscreenRequests: [],
    image: { data: btoa(String.fromCharCode(255,216,255,0)) },
    images: [],
    imageError: null,
    imageDelay: 0,
    imageCompression: null,
    imageSelections: new Map(),
    imageReads: [],
    imageReleases: [],
    resizes: [],
    pendingLink: null,
    cameraGranted: false,
    nextSession: 1,
  }

  function push(session, chunk) {
    session.output.push(chunk)
    session.next += 1
    for (const wake of session.waiters.splice(0)) wake()
  }

  function read(session, from) {
    const base = session.next - session.output.length
    const reset = from < base || from > session.next
    const start = reset ? 0 : from - base
    const chunks = session.output.slice(start, start + 4)
    const next = base + start + chunks.length
    return { ...sessionMetadata(session), chunks, next, more: next < session.next, reset, exit: session.exit,
      historyBefore: session.history?.length ?? 0, historyAvailable: !!session.history?.length }
  }

  function latest(session) {
    // A controlled screen stand-in; native parser correctness is covered by Rust tests.
    const decoder = new TextDecoder()
    const text = session.output.map(chunk => typeof chunk === 'string'
      ? decoder.decode(Uint8Array.from(atob(chunk), ch => ch.charCodeAt(0))) : chunk.data).join('')
    const screen = session.snapshot ?? { data: text.split('\n').slice(-12).join('\r\n'), cols: 80, rows: 24 }
    return { ...sessionMetadata(session), chunks: [screen], next: session.next, more: false, reset: false, snapshot: true, exit: session.exit,
      historyBefore: session.history?.length ?? 0, historyAvailable: !!session.history?.length }
  }

  function sessionMetadata(session) {
    const lastActiveAt = session.lastActiveAt ?? Date.now()
    const basic = { id: session.id, number: session.number, exit: session.exit,
      lastActiveAt, idleDeadline: session.exit ? null : lastActiveAt + 24 * 3600e3 }
    return state.sessionNames ? { ...basic, name: session.customName ?? session.title ?? '终端 ' + session.number,
      programTitle: session.title ?? null,
      customName: session.customName ?? null, nameRevision: session.nameRevision ?? 0 } : basic
  }


  // ---------- 聊天式 Agent 内存后端（对应 src-tauri/src/agent/） ----------
  const SAFETY = {
    claude: [
      { id: 'default', label: '每次询问', description: '编辑文件和运行命令前在手机上确认', full: false },
      { id: 'acceptEdits', label: '自动编辑', description: '自动接受文件编辑；运行命令前在手机上确认', full: false },
      { id: 'plan', label: '只规划', description: '只读分析并给出计划，批准后再动手', full: false },
      { id: 'bypassPermissions', label: '完全访问', description: '不再询问，直接编辑文件和运行命令', full: true },
    ],
    codex: [
      { id: 'read-only', label: '只读', description: '可读取文件；编辑文件和运行命令前在手机上确认', full: false },
      { id: 'auto', label: '自动', description: '在项目内自动编辑和运行命令；越过沙箱时在手机上确认', full: false },
      { id: 'full', label: '完全访问', description: '不受沙箱限制，不再询问，直接编辑文件和运行命令', full: true },
    ],
    opencode: [
      { id: 'ask', label: '每次询问', description: '编辑文件、运行命令和联网前在手机上确认', full: false },
      { id: 'edits', label: '自动编辑', description: '自动接受文件编辑；运行命令和联网前在手机上确认', full: false },
      { id: 'full', label: '完全访问', description: '不再询问，直接编辑文件、运行命令和联网', full: true },
    ],
  }
  const NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
  state.agent = {
    defaults: { claude: 'default', codex: 'auto', opencode: 'ask' },
    threads: new Map(),
    requests: [],
    attachments: new Map(),
    stepDelay: 40,
    quotas: [
      { provider: 'claude', name: 'Claude', plan: 'pro', windows: [{ label: '5 小时', percent: 22, resetsAt: new Date(Date.now() + 3 * 3600e3).toISOString() }, { label: '每周', percent: 42, resetsAt: new Date(Date.now() + 4 * 86400e3).toISOString() }], updatedAt: Date.now() },
      { provider: 'codex', name: 'Codex', error: 'Codex 未登录，请先在电脑上运行 codex 登录。', updatedAt: Date.now() },
      { provider: 'opencode', name: 'OpenCode', note: 'OpenCode 按所选模型的提供方计费，额度请在提供方查看；对话内显示本会话用量。' },
    ],
    nextId: 1,
  }

  function agentCatalog() {
    return ['claude', 'codex', 'opencode'].map(id => ({ id, name: NAMES[id], safety: SAFETY[id], defaultSafety: state.agent.defaults[id], defaultModel: null, installed: id !== 'codex' }))
  }

  function agentMeta(thread) {
    const pending = thread.items.filter(item => item.kind === 'approval' && item.approval.state === 'pending').length
    const preview = [...thread.items].reverse().find(item => (item.kind === 'assistant' || item.kind === 'user') && item.text)?.text ?? ''
    const project = state.projects.find(item => item.id === thread.projectId)
    return { id: thread.id, provider: thread.provider, projectId: thread.projectId, projectName: project?.name ?? '', projectKind: project?.kind, projectHost: project?.host,
      title: thread.title, titleManual: thread.titleManual, status: thread.status, error: null, running: thread.running, safety: thread.safety, model: thread.model,
      effort: thread.effort, mode: thread.mode, createdAt: thread.createdAt, updatedAt: thread.updatedAt, rev: thread.rev, pending, preview: preview.slice(0, 120),
      usage: thread.usage, options: thread.options,
      ...(thread.running ? { lastActiveAt: thread.updatedAt, idleDeadline: thread.updatedAt + 24 * 3600e3 } : {}) }
  }

  function agentUpsert(thread, id, kind, change) {
    thread.rev += 1
    thread.updatedAt = Date.now()
    let item = thread.items.find(entry => entry.id === id)
    if (!item) {
      item = { id, kind, time: Date.now() }
      thread.items.push(item)
    }
    change(item)
    item.rev = thread.rev
    for (const wake of thread.waiters.splice(0)) wake()
    return item
  }

  function agentStatus(thread, status) {
    thread.status = status
    thread.rev += 1
    for (const wake of thread.waiters.splice(0)) wake()
  }

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  // 一轮脚本化回复：思考、流式文字、命令、需要审批的编辑、总结。
  async function agentTurn(thread, text) {
    const turn = thread.turns = (thread.turns ?? 0) + 1
    const delay = () => wait(state.agent.stepDelay)
    agentStatus(thread, 'running')
    await delay()
    agentUpsert(thread, `r-${turn}`, 'reasoning', item => { item.text = '先查看项目结构，再定位需要修改的文件。'; item.streaming = true })
    await delay()
    agentUpsert(thread, `r-${turn}`, 'reasoning', item => { delete item.streaming })
    const reply = `好的，我来处理：**${text.trim().slice(0, 40)}**\n\n1. 查看 \`src/\` 目录\n2. 修改相关代码\n\n\`\`\`ts\nexport const answer = 42\n\`\`\``
    for (let end = 8; end <= reply.length + 7; end += 8) {
      agentUpsert(thread, `a-${turn}`, 'assistant', item => { item.text = reply.slice(0, end); item.streaming = true })
      await delay()
    }
    agentUpsert(thread, `a-${turn}`, 'assistant', item => { item.text = reply; delete item.streaming })
    agentUpsert(thread, `t-${turn}`, 'tool', item => { item.tool = { category: 'command', title: 'ls src', status: 'running' } })
    await delay()
    agentUpsert(thread, `t-${turn}`, 'tool', item => { item.tool = { category: 'command', title: 'ls src', status: 'done', exitCode: 0, output: 'app.ts\nlib.ts\n' } })
    const files = [{ path: 'src/app.ts', change: 'update', diff: '@@ -1 +1 @@\n-export const answer = 41\n+export const answer = 42\n' }]
    const full = SAFETY[thread.provider].find(option => option.id === thread.safety)?.full
    if (!full) {
      agentUpsert(thread, `p-${turn}`, 'approval', item => {
        item.approval = { type: 'edit', title: 'src/app.ts', detail: '', state: 'pending', options: [
          { id: 'accept', label: '允许', tone: 'primary' }, { id: 'acceptForSession', label: '本会话允许', tone: 'neutral' }, { id: 'decline', label: '拒绝', tone: 'danger' }] }
        item.files = files
      })
      const choice = await new Promise(resolve => { thread.answer = resolve })
      if (choice === 'decline') {
        agentUpsert(thread, `e-${turn}`, 'tool', item => { item.tool = { category: 'edit', title: 'src/app.ts', status: 'declined', files } })
        agentUpsert(thread, `s-${turn}`, 'assistant', item => { item.text = '已按你的选择跳过修改。' })
        thread.usage = { contextUsed: 12000, contextWindow: 200000, cost: { amount: 0.012, currency: 'USD' } }
        agentStatus(thread, 'idle')
        return
      }
    }
    agentUpsert(thread, `e-${turn}`, 'tool', item => { item.tool = { category: 'edit', title: 'src/app.ts', status: 'done', files } })
    agentUpsert(thread, `plan-${turn}`, 'plan', item => { item.steps = [{ text: '查看目录', status: 'done' }, { text: '修改代码', status: 'done' }, { text: '运行测试', status: 'pending' }] })
    agentUpsert(thread, `s-${turn}`, 'assistant', item => { item.text = '已修改 `src/app.ts`。详情见 https://example.com/docs 。' })
    thread.usage = { contextUsed: 24000, contextWindow: 200000, cost: { amount: 0.024, currency: 'USD' } }
    agentStatus(thread, 'idle')
  }

  async function agent(request) {
    const fail = error => ({ ok: false, error })
    const thread = request.id ? state.agent.threads.get(request.id) : null
    state.agent.requests.push(request)
    if (state.agent.unsupported) return fail('请求格式无效。')
    switch (request.op) {
      case 'agent_catalog': return { ok: true, data: agentCatalog() }
      case 'agent_defaults': state.agent.defaults[request.provider] = request.safety; return { ok: true, data: agentCatalog() }
      case 'agent_threads': return { ok: true, data: [...state.agent.threads.values()].map(agentMeta) }
      case 'agent_usage': return { ok: true, data: state.agent.quotas }
      case 'agent_create': {
        const project = state.projects.find(item => item.id === request.project)
        if (!project) return fail('请在 Windows QingCode 中信任该项目后重试。')
        if (/^ssh:\/\/[^/]+\/+[A-Za-z]:/.test(project.path)) return fail('Windows 远端暂不支持对话模式，请使用终端。')
        const id = 'agent-' + state.agent.nextId++
        const created = { id, provider: request.provider, projectId: project.id, title: '', titleManual: false, status: 'idle', running: true,
          safety: request.safety ?? state.agent.defaults[request.provider], model: null, effort: null, mode: null, createdAt: Date.now(), updatedAt: Date.now(),
          rev: 1, items: [], waiters: [], usage: null,
          options: { models: [{ id: 'm-fast', label: 'Fast' }, { id: 'm-smart', label: 'Smart', efforts: ['low', 'high'] }], modes: request.provider === 'opencode' ? [{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }] : undefined } }
        state.agent.threads.set(id, created)
        return { ok: true, data: agentMeta(created) }
      }
      case 'agent_image': {
        const id = 'img-' + state.agent.attachments.size
        state.agent.attachments.set(id, request.data)
        return { ok: true, data: { id, mime: 'image/jpeg' } }
      }
    }
    if (!thread) return fail('对话不存在或已删除。')
    switch (request.op) {
      case 'agent_send': {
        if (thread.status === 'running') return fail('Agent 正在执行，请等待完成或先停止。')
        const text = request.text ?? ''
        agentUpsert(thread, 'u-' + thread.rev, 'user', item => { item.text = text; if (request.images?.length) item.images = request.images.length })
        if (!thread.title) thread.title = text.split('\n')[0].slice(0, 60)
        thread.running = true
        void agentTurn(thread, text)
        return { ok: true, data: agentMeta(thread) }
      }
      case 'agent_poll': {
        if (state.agent.pollErrors > 0) { state.agent.pollErrors--; return fail('模拟网络断开') }
        if (request.from === thread.rev) await new Promise(resolve => { thread.waiters.push(resolve); setTimeout(resolve, 1500) })
        await wait(10)
        const full = request.from === 0 || request.from > thread.rev
        const items = full ? thread.items.slice(-300) : thread.items.filter(item => item.rev > request.from)
        return { ok: true, data: { thread: agentMeta(thread), items: structuredClone(items), full, rev: thread.rev } }
      }
      case 'agent_history': return { ok: true, data: { items: [] } }
      case 'agent_respond': {
        const item = thread.items.find(entry => entry.id === request.approval)
        if (!item || item.approval.state !== 'pending') return fail('该请求已处理或已失效。')
        agentUpsert(thread, item.id, 'approval', entry => { entry.approval.state = 'resolved'; entry.approval.choice = request.choice })
        thread.answer?.(request.choice)
        return { ok: true, data: null }
      }
      case 'agent_interrupt': {
        thread.answer?.('decline')
        agentStatus(thread, 'idle')
        return { ok: true, data: null }
      }
      case 'agent_configure': {
        if (request.key === 'safety' && !SAFETY[thread.provider].some(option => option.id === request.value)) return fail('无效的安全选项。')
        thread[request.key] = request.value || null
        thread.rev += 1
        return { ok: true, data: agentMeta(thread) }
      }
      case 'agent_rename': thread.title = request.title.trim(); thread.titleManual = !!thread.title; thread.rev += 1; return { ok: true, data: agentMeta(thread) }
      case 'agent_close': thread.running = false; agentStatus(thread, 'closed'); return { ok: true, data: null }
      case 'agent_delete': state.agent.threads.delete(thread.id); return { ok: true, data: null }
      default: return fail('未知操作。')
    }
  }

  async function remote(profile, request) {
    const saved = state.profiles.get(profile)
    if (!saved) return { ok: false, error: '请先完成密码配对。' }
    if (state.hosts.get(saved.id) !== saved.fingerprint) return { ok: false, error: 'Windows 身份校验失败，请重新核对证书指纹。' }
    if (request.op.startsWith('agent_')) return agent(request)
    switch (request.op) {
      case 'capabilities':
        state.capabilityRequests += 1
        return state.capabilities ? { ok: true, data: state.capabilities } : { ok: false, error: '请求格式无效。' }
      case 'projects': return { ok: true, data: state.projects }
      case 'sessions': {
        state.sessionRequests.push({ project: request.project, at: Date.now() })
        const data = [...state.sessions.values()].filter(item => item.project === request.project).map(sessionMetadata)
        if (state.sessionDelay) await new Promise(resolve => setTimeout(resolve, state.sessionDelay))
        if (state.sessionError) return { ok: false, error: state.sessionError }
        return {
          ok: true,
          data,
        }
      }
      case 'terminal_profiles':
        state.terminalProfileRequests += 1
        return state.terminalProfiles ? { ok: true, data: state.terminalProfiles } : { ok: false, error: '请求格式无效。' }
      case 'create': {
        const chosen = request.terminal_profile && state.terminalProfiles?.find(item => item.id === request.terminal_profile)
        if (request.terminal_profile && state.terminalProfiles && !chosen) return { ok: false, error: '终端配置不存在或已删除，请刷新后重试。' }
        if (chosen && !chosen.trusted) return { ok: false, error: `请先在电脑上新建一次「${chosen.name}」终端并选择「信任此配置」，再从手机启动。` }
        state.creates.push({ project: request.project, terminalProfile: request.terminal_profile ?? null })
        const number = state.nextSession++
        const session = { id: 'mobile-' + number, number, project: request.project, output: [], next: 0, waiters: [], exit: null }
        state.sessions.set(session.id, session)
        push(session, base64('PS D:\\code\\qingcode> '))
        return { ok: true, data: sessionMetadata(session) }
      }
      case 'rename_session': {
        if (state.renameDelay) await new Promise(resolve => setTimeout(resolve, state.renameDelay))
        if (state.renameError) return { ok: false, error: state.renameError }
        if (!state.sessionNames) return { ok: false, error: '请更新电脑端' }
        const session = state.sessions.get(request.id)
        if (!session) return { ok: false, error: '终端不存在。' }
        const name = request.name.trim()
        if ([...name].length > 80 || /[\x00-\x1f\x7f]/.test(name)) return { ok: false, error: '会话名称无效' }
        session.customName = name || null
        session.nameRevision = (session.nameRevision ?? 0) + 1
        for (const wake of session.waiters.splice(0)) wake()
        return { ok: true, data: sessionMetadata(session) }
      }
      case 'poll': {
        const session = state.sessions.get(request.id)
        if (!session) return { ok: false, error: '终端不存在。' }
        state.polls.push({ id: request.id, from: request.from, latest: request.latest, tail: request.tail })
        if (state.pollErrors > 0) { state.pollErrors--; return { ok: false, error: '模拟网络断开' } }
        if (request.latest || (request.tail && request.from < session.next - session.output.length)) {
          return { ok: true, data: latest(session) }
        }
        if (request.from === session.next && !session.exit) {
          await new Promise(resolve => {
            session.waiters.push(resolve)
            setTimeout(resolve, 900)
          })
        }
        return { ok: true, data: read(session, request.from) }
      }
      case 'history': {
        const session = state.sessions.get(request.id)
        if (!session) return { ok: false, error: '终端不存在。' }
        state.historyRequests.push({ id: request.id, before: request.before })
        if (state.historyDelay) await new Promise(resolve => setTimeout(resolve, state.historyDelay))
        if (state.historyError) return { ok: false, error: state.historyError }
        const end = Math.min(request.before, session.history?.length ?? 0)
        const start = Math.max(0, end - 120)
        return { ok: true, data: { lines: (session.history ?? []).slice(start, end), before: start,
          more: start > 0, truncated: !!session.truncated && start === 0 } }
      }
      case 'input': {
        const session = state.sessions.get(request.id)
        if (!session) return { ok: false, error: '终端不存在。' }
        state.inputs.push(request.data)
        const inputEvent = { data: request.data, startedAt: performance.now() }
        state.inputEvents.push(inputEvent)
        if (state.inputGate) await state.inputGate
        if (state.inputDelay) await new Promise(resolve => setTimeout(resolve, state.inputDelay))
        if (state.inputError) return { ok: false, error: state.inputError }
        inputEvent.receivedAt = performance.now()
        // Echo printable input; a submitted line prints a fake result and a new prompt.
        const echoed = request.data.replace(/\r/g, '\r\n')
        push(session, base64(echoed + (request.data.endsWith('\r') ? 'ok\r\nPS D:\\code\\qingcode> ' : '')))
        return { ok: true, data: null }
      }
      case 'image': {
        if (state.imageGate) await state.imageGate
        if (state.imageDelay) await new Promise(resolve => setTimeout(resolve, state.imageDelay))
        if (state.imageError) return { ok: false, error: state.imageError }
        if (!state.sessions.has(request.id)) return { ok: false, error: '终端不存在。' }
        state.images.push(request)
        return { ok: true, data: { path: state.imagePaths?.[state.images.length - 1] ?? "'/tmp/mobile-image.jpg'" } }
      }
      case 'resize': state.resizes.push(request); return { ok: true, data: null }
      case 'end': {
        state.ends.push(request.id)
        if (state.endErrors.has(request.id)) return { ok: false, error: '模拟结束失败' }
        state.sessions.delete(request.id)
        return { ok: true, data: null }
      }
      default: return { ok: false, error: '未知操作。' }
    }
  }

  async function perform(request) {
    switch (request.op) {
      case 'profiles': return { ok: true, data: [...state.profiles.values()].map(summary) }
      case 'clipboard': return { ok: true, data: state.clipboard }
      case 'latency': {
        const value = state.latency
        const supported = state.latencySupported
        const error = state.latencyError
        state.latencyRequests.push({ profile: request.profile, at: Date.now() })
        if (state.latencyDelay) await new Promise(resolve => setTimeout(resolve, state.latencyDelay))
        if (error) return { ok: false, error }
        return { ok: true, data: { supported, milliseconds: value } }
      }
      case 'open_link': {
        const url = new URL(request.url)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return { ok: false, error: '无效网页链接' }
        state.openedLinks.push(request.url)
        return { ok: true, data: true }
      }
      case 'copy':
        if (state.copyError) return { ok: false, error: state.copyError }
        state.clipboard = request.text
        return { ok: true, data: true }
      case 'fullscreen': {
        if (state.fullscreenError) return { ok: false, error: state.fullscreenError };
        state.fullscreenRequests.push(request.enabled);
        state.fullscreen = request.enabled === true;
        return { ok: true, data: state.fullscreen };
      }
      case 'pendingLink': {
        const link = state.pendingLink
        state.pendingLink = null
        return { ok: true, data: link }
      }
      case 'pick_image': {
        state.imageCompression = request.compression
        if (!Array.isArray(state.image)) return { ok: true, data: state.image }
        if (!state.image.length) return { ok: true, data: null }
        const selection = 'fixture-selection-' + Date.now()
        state.imageSelections.set(selection, state.image.slice())
        return { ok: true, data: { selection, count: state.image.length } }
      }
      case 'read_image': {
        state.imageReads.push(request.index)
        const image = state.imageSelections.get(request.selection)?.[request.index]
        if (!image) return { ok: false, error: '图片选择已失效，请重新选择。' }
        if (image.error) return { ok: false, error: image.error }
        return { ok: true, data: image }
      }
      case 'release_images':
        state.imageReleases.push(request.selection)
        state.imageSelections.delete(request.selection)
        return { ok: true, data: true }
      case 'camera': return { ok: true, data: state.cameraGranted }
      case 'probe': {
        const fingerprint = state.hosts.get(request.host + ':' + request.port)
        return fingerprint ? { ok: true, data: fingerprint } : { ok: false, error: '连接超时，请确认电脑在线并允许局域网访问。' }
      }
      case 'pair': {
        const id = request.host + ':' + request.port
        state.pairs.push({ id, fingerprint: request.fingerprint })
        if (request.code !== CODE) return { ok: false, error: '密码不正确。' }
        const saved = { id, name: request.name, host: request.host, port: request.port, fingerprint: request.fingerprint }
        state.profiles.set(id, saved)
        return { ok: true, data: summary(saved) }
      }
      case 'forget': state.profiles.delete(request.profile); return { ok: true, data: null }
      case 'rename': {
        const saved = state.profiles.get(request.profile)
        saved.name = request.name.trim()
        return { ok: true, data: summary(saved) }
      }
      case 'readdress': {
        const saved = state.profiles.get(request.profile)
        const id = saved.host + ':' + request.port
        state.profiles.delete(saved.id)
        Object.assign(saved, { id, port: request.port })
        state.profiles.set(id, saved)
        return { ok: true, data: summary(saved) }
      }
      default: {
        const { profile, ...rest } = request
        return remote(profile, rest)
      }
    }
  }

  function summary(saved) {
    return { id: saved.id, name: saved.name, host: saved.host, port: saved.port, fingerprint: saved.fingerprint }
  }

  window.QingCodeNative = {
    request(id, payload) {
      const request = JSON.parse(payload)
      setTimeout(() => {
        perform(request).then(result => window.qingReply(id, result))
      }, 15)
    },
  }

  // Capture xterm instances so assertions read the buffer instead of rendered rows,
  // which may not repaint in a background browser window.
  const terminals = []
  let Terminal
  Object.defineProperty(window, 'Terminal', {
    configurable: true,
    get: () => Terminal,
    set(value) {
      Terminal = class extends value {
        constructor(...args) {
          super(...args)
          terminals.push(this)
        }
      }
    },
  })

  window.__mobileFixture = {
    state,
    terminalSize() {
      const term = terminals.at(-1)
      return term ? { cols: term.cols, rows: term.rows } : null
    },
    terminalText() {
      const term = terminals.at(-1)
      if (!term) return ''
      const buffer = term.buffer.active
      const lines = []
      for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
      return lines.join('\n')
    },
    fingerprint: FINGERPRINT,
    code: CODE,
    setTitle(id, title) {
      const session = state.sessions.get(id)
      session.title = title
      session.nameRevision = (session.nameRevision ?? 0) + 1
      for (const wake of session.waiters.splice(0)) wake()
    },
    pushScreen(id, text, cols = 80, rows = 24) {
      push(state.sessions.get(id), { data: text, cols, rows })
    },
    link(host, port, fingerprint = FINGERPRINT, name = 'DEVBOX') {
      const query = new URLSearchParams({ v: '1', host, port: String(port), fp: fingerprint, name })
      return 'qingcode://pair?' + query.toString()
    },
  }
})()
