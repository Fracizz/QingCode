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
    inputs: [],
    polls: [],
    historyRequests: [],
    pairs: [],
    clipboard: '',
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
    return { chunks, next, more: next < session.next, reset, exit: session.exit,
      historyBefore: session.history?.length ?? 0, historyAvailable: !!session.history?.length }
  }

  function latest(session) {
    // A controlled screen stand-in; native parser correctness is covered by Rust tests.
    const decoder = new TextDecoder()
    const text = session.output.map(chunk => typeof chunk === 'string'
      ? decoder.decode(Uint8Array.from(atob(chunk), ch => ch.charCodeAt(0))) : chunk.data).join('')
    const screen = session.snapshot ?? { data: text.split('\n').slice(-12).join('\r\n'), cols: 80, rows: 24 }
    return { chunks: [screen], next: session.next, more: false, reset: false, snapshot: true, exit: session.exit,
      historyBefore: session.history?.length ?? 0, historyAvailable: !!session.history?.length }
  }

  async function remote(profile, request) {
    const saved = state.profiles.get(profile)
    if (!saved) return { ok: false, error: '请先完成密码配对。' }
    if (state.hosts.get(saved.id) !== saved.fingerprint) return { ok: false, error: 'Windows 身份校验失败，请重新核对证书指纹。' }
    switch (request.op) {
      case 'projects': return { ok: true, data: state.projects }
      case 'sessions': return {
        ok: true,
        data: [...state.sessions.values()].filter(item => item.project === request.project)
          .map(item => ({ id: item.id, number: item.number, exit: item.exit })),
      }
      case 'create': {
        const number = state.nextSession++
        const session = { id: 'mobile-' + number, number, project: request.project, output: [], next: 0, waiters: [], exit: null }
        state.sessions.set(session.id, session)
        push(session, base64('PS D:\\code\\qingcode> '))
        return { ok: true, data: { id: session.id, number } }
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
        // Echo printable input; a submitted line prints a fake result and a new prompt.
        const echoed = request.data.replace(/\r/g, '\r\n')
        push(session, base64(echoed + (request.data.endsWith('\r') ? 'ok\r\nPS D:\\code\\qingcode> ' : '')))
        return { ok: true, data: null }
      }
      case 'image': {
        if (state.imageDelay) await new Promise(resolve => setTimeout(resolve, state.imageDelay))
        if (state.imageError) return { ok: false, error: state.imageError }
        if (!state.sessions.has(request.id)) return { ok: false, error: '终端不存在。' }
        state.images.push(request)
        return { ok: true, data: { path: "'/tmp/mobile-image.jpg'" } }
      }
      case 'resize': return { ok: true, data: null }
      case 'end': state.sessions.delete(request.id); return { ok: true, data: null }
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
      case 'pick_image': state.imageCompression = request.compression; return { ok: true, data: state.image }
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
    pushScreen(id, text, cols = 80, rows = 24) {
      push(state.sessions.get(id), { data: text, cols, rows })
    },
    link(host, port, fingerprint = FINGERPRINT, name = 'DEVBOX') {
      const query = new URLSearchParams({ v: '1', host, port: String(port), fp: fingerprint, name })
      return 'qingcode://pair?' + query.toString()
    },
  }
})()
