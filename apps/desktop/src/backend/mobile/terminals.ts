import { createHash, randomUUID } from 'node:crypto'
import { RouterError } from '../router'
import { mobileProject } from './projectAccess'

export const MOBILE_TERMINAL_METHODS = new Set([
  'mobile.term.list', 'mobile.term.open', 'mobile.term.attach', 'mobile.term.detach',
  'mobile.term.write', 'mobile.term.resize', 'mobile.term.close',
])

type RecordValue = Record<string, unknown>
const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
type Invoke = (method: string, params: unknown) => Promise<unknown>
type Subscription = { deviceId: string; projectId: string; targetId: string }
const termKey = (targetId: string, termId: string) => JSON.stringify([targetId, termId])
const eventNames = new Set(['term.data', 'term.exit', 'term.resized', 'term.error'])

function terminalPrefix(deviceId: string, project: { id: string; targetId: string; root: string }): string {
  const digest = createHash('sha256').update(JSON.stringify([deviceId, project.targetId, project.id, project.root])).digest('hex')
  return `qm-${digest.slice(0, 24)}-`
}

function ownedTerminal(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && /^[a-f0-9]{32}$/.test(value.slice(prefix.length))
}

export class MobileTerminals {
  private enabled = false
  private readonly subscriptions = new Map<string, Subscription>()
  private revision = 0

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.clear()
  }

  clear(): void {
    this.revision += 1
    this.subscriptions.clear()
  }

  disconnectDevice(deviceId: string): void {
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.deviceId === deviceId) this.subscriptions.delete(key)
    }
  }

  toDevice(raw: unknown): { deviceId: string; event: { name: string; payload: unknown } } | null {
    if (!this.enabled || !isRecord(raw) || typeof raw.targetId !== 'string' ||
      typeof raw.name !== 'string' || !eventNames.has(raw.name) || !isRecord(raw.payload) ||
      typeof raw.payload.termId !== 'string') return null
    const key = termKey(raw.targetId, raw.payload.termId)
    const subscription = this.subscriptions.get(key)
    if (!subscription) return null
    return {
      deviceId: subscription.deviceId,
      event: { name: 'mobile.terminal', payload: {
        targetId: subscription.targetId,
        projectId: subscription.projectId,
        name: raw.name,
        payload: raw.payload,
      } },
    }
  }

  async run(invoke: Invoke, deviceId: string, method: string, raw: unknown): Promise<unknown> {
    if (!this.enabled) throw new RouterError('terminal_disabled', '请在电脑的手机连接设置中启用手机终端')
    const revision = this.revision
    const project = await mobileProject(invoke, raw)
    if (revision !== this.revision) throw new RouterError('terminal_disabled', '手机终端授权已变化，请重试')
    const prefix = terminalPrefix(deviceId, project)
    const req = (name: string, params: unknown) => invoke('server.req', { targetId: project.targetId, method: name, params })
    const { termId, sinceSeq, cols, rows, data } = project.params
    switch (method) {
      case 'mobile.term.list': {
        const result = await req('term.list', {})
        const list = isRecord(result) && Array.isArray(result.terminals) ? result.terminals : []
        return { terminals: list.filter((value) => isRecord(value) && ownedTerminal(value.termId, prefix)) }
      }
      case 'mobile.term.open':
        return req('term.open', {
          termId: `${prefix}${randomUUID().replace(/-/g, '')}`,
          cwd: project.root,
          cols,
          rows,
        })
    }

    if (!ownedTerminal(termId, prefix)) throw new RouterError('forbidden', '终端不属于当前设备或项目')
    const key = termKey(project.targetId, termId)
    switch (method) {
      case 'mobile.term.attach': {
        const prior = this.subscriptions.get(key)
        const next = { deviceId, projectId: project.id, targetId: project.targetId }
        this.subscriptions.set(key, next)
        try {
          return await req('term.attach', { termId, sinceSeq })
        } catch (error) {
          if (this.subscriptions.get(key) === next) {
            if (prior) this.subscriptions.set(key, prior)
            else this.subscriptions.delete(key)
          }
          throw error
        }
      }
      case 'mobile.term.detach':
        this.subscriptions.delete(key)
        return req('term.detach', { termId })
      case 'mobile.term.write':
        return req('term.write', { termId, data })
      case 'mobile.term.resize':
        return req('term.resize', { termId, cols, rows })
      case 'mobile.term.close':
        this.subscriptions.delete(key)
        return req('term.close', { termId })
      default:
        throw new RouterError('invalid_params', '未知手机终端操作')
    }
  }
}
