import { create } from 'zustand'
import type {
  DirectTarget,
  DirectTargetInput,
  EnableDirectParams,
  HostKeyPrompt,
  SshTarget,
  SshTargetInput,
  Target,
  TargetProbe,
  TargetStateEvent,
} from '../../../shared/backendApi'
import { call, on, onBackendRestart } from '../lib/backend'
import { friendlyError } from '../lib/errors'

export type ConnectCredentials = {
  password?: string
  passphrase?: string
  remember?: boolean
}

type TargetsState = {
  targets: Target[]
  selectedId: string
  states: Record<string, TargetStateEvent>
  connectErrors: Record<string, string>
  prompts: HostKeyPrompt[]
  loaded: boolean
  error: string | null
  notice: string | null
  load: () => Promise<void>
  select: (id: string) => void
  save: (input: SshTargetInput | DirectTargetInput) => Promise<SshTarget | DirectTarget>
  test: (input: SshTargetInput, credentials: ConnectCredentials) => Promise<TargetProbe>
  enableDirect: (params: EnableDirectParams) => Promise<SshTarget>
  disableDirect: (id: string, credentials?: { password?: string; passphrase?: string }) => Promise<SshTarget>
  remove: (id: string) => Promise<void>
  connect: (id: string, credentials?: ConnectCredentials) => Promise<void>
  disconnect: (id: string) => Promise<void>
  forgetSecret: (id: string) => Promise<void>
  respondHostKey: (promptId: string, accept: boolean) => Promise<void>
  dismissNotice: () => void
}

let subscribed = false

export const useTargets = create<TargetsState>((set, get) => ({
  targets: [],
  selectedId: 'local',
  states: {},
  connectErrors: {},
  prompts: [],
  loaded: false,
  error: null,
  notice: null,

  load: async () => {
    if (!subscribed) {
      subscribed = true
      onBackendRestart(() => {
        // 新的 backend 进程里没有任何连接，界面上残留的"已连接"是假的：清掉后按原样补连。
        const { states, connect } = get()
        const active = Object.values(states).filter((item) => item.state !== 'idle')
        set({ states: {}, prompts: [] })
        for (const item of active) void connect(item.id)
      })
      on('target.state', (payload) => {
        useTargets.setState((s) => ({
          states: { ...s.states, [payload.id]: payload },
          connectErrors:
            payload.state === 'error' ? s.connectErrors : omitKey(s.connectErrors, payload.id),
        }))
      })
      on('hostKey.prompt', (prompt) => {
        useTargets.setState((s) => ({
          prompts: s.prompts.some((item) => item.promptId === prompt.promptId)
            ? s.prompts
            : [...s.prompts, prompt],
        }))
      })
    }
    try {
      const targets = await call('targets.list')
      set({ targets, loaded: true, error: null })
    } catch (err) {
      set({ error: friendlyError(err, '加载目标列表失败') })
    }
  },

  select: (id) => set({ selectedId: id }),

  save: async (input) => {
    // 后端返回的就是已落库的目标，就地按 id 合并，省一次全量拉取。
    const target = await call('targets.save', input)
    set((s) => ({ targets: upsertTarget(s.targets, target) }))
    return target
  },

  enableDirect: async (params) => {
    const target = await call('target.enableDirect', params)
    set((s) => ({ targets: upsertTarget(s.targets, target) }))
    return target
  },

  disableDirect: async (id, credentials) => {
    const target = await call('target.disableDirect', {
      id,
      ...(credentials?.password ? { password: credentials.password } : {}),
      ...(credentials?.passphrase ? { passphrase: credentials.passphrase } : {}),
    })
    set((s) => ({ targets: upsertTarget(s.targets, target) }))
    return target
  },

  test: (input, { password, passphrase }) =>
    call('target.test', {
      ...input,
      ...(password ? { password } : {}),
      ...(passphrase ? { passphrase } : {}),
    }),

  remove: async (id) => {
    await call('targets.remove', { id })
    await get().load()
  },

  connect: async (id, credentials) => {
    set((s) => ({
      states: { ...s.states, [id]: { id, state: 'connecting', detail: '正在连接…' } },
      connectErrors: omitKey(s.connectErrors, id),
    }))
    try {
      await call('target.connect', { id, ...(credentials ?? {}) })
      // 后端会推 ready；若没有事件也保证 UI 能进入下一步。
      set((s) =>
        s.states[id]?.state === 'connecting' || s.states[id]?.state === 'deploying'
          ? { states: { ...s.states, [id]: { id, state: 'ready' } } }
          : s,
      )
    } catch (err) {
      const message = friendlyError(err, '连接失败')
      set((s) => ({
        states: { ...s.states, [id]: { id, state: 'error', detail: message } },
        connectErrors: { ...s.connectErrors, [id]: message },
      }))
    }
  },

  disconnect: async (id) => {
    try {
      await call('target.disconnect', { id })
      set((s) => ({ states: { ...s.states, [id]: { id, state: 'idle' } } }))
    } catch (err) {
      set({ notice: friendlyError(err, '断开连接失败') })
    }
  },

  forgetSecret: async (id) => {
    try {
      await call('target.forgetSecret', { id })
      set({ notice: '已删除本机保存的密码/口令' })
    } catch (err) {
      set({ notice: friendlyError(err, '忘记已保存的密码失败') })
    }
  },

  respondHostKey: async (promptId, accept) => {
    set((s) => ({ prompts: s.prompts.filter((item) => item.promptId !== promptId) }))
    try {
      await call('hostKey.respond', { promptId, accept })
      if (!accept) set({ notice: '已拒绝该主机指纹，连接已取消' })
    } catch (err) {
      set({ notice: friendlyError(err, '回应主机指纹失败') })
    }
  },

  dismissNotice: () => set({ notice: null }),
}))

function upsertTarget(targets: Target[], target: SshTarget | DirectTarget): Target[] {
  const index = targets.findIndex((item) => item.id === target.id)
  if (index < 0) return [...targets, target]
  const next = [...targets]
  next[index] = target
  return next
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record
  const next = { ...record }
  delete next[key]
  return next
}
