import { randomUUID } from 'node:crypto'
import type { HostKeyPrompt } from '../shared/backendApi'
import {
  checkHostKey,
  hostKeyId,
  previousHostKey,
  readKnownHosts,
  setHostKey,
  writeKnownHosts,
} from './hostKeys'
import type { HostKeyVerifier } from './types'

export interface HostKeyGateOptions {
  userData: string
  emit(prompt: HostKeyPrompt): void
  /** 集成脚本用：新主机自动接受，指纹变化仍必须明确确认。 */
  autoAcceptNew?: boolean
  timeoutMs?: number
}

interface PendingDecision {
  key: string
  promptId: string
  promise: Promise<boolean>
  resolve(accept: boolean): void
  timer: ReturnType<typeof setTimeout>
}

export interface HostKeyDecider extends HostKeyVerifier {
  respond(promptId: string, accept: boolean): boolean
  close(): void
}

/** 把异步的 hostVerifier 决策接到渲染进程的 hostKey.prompt / hostKey.respond。 */
export class HostKeyGate implements HostKeyDecider {
  private readonly pending = new Map<string, PendingDecision>()

  constructor(private readonly options: HostKeyGateOptions) {}

  async verify(host: string, port: number, fingerprint: string, interactive = true): Promise<boolean> {
    const store = await readKnownHosts(this.options.userData)
    const verdict = checkHostKey(store, host, port, fingerprint)
    if (verdict === 'match') return true
    if (!interactive) return false

    const previous = previousHostKey(store, host, port)
    if (this.options.autoAcceptNew === true && verdict === 'new') {
      await this.persist(host, port, fingerprint)
      return true
    }

    const key = `${hostKeyId(host, port)}|${fingerprint}`
    // 20s 握超时会让 ssh2 重连；同一指纹的多次握手共用一次用户确认。
    const existing = this.pending.get(key)
    if (existing) return existing.promise

    const promptId = `hostkey-${randomUUID()}`
    let decision!: (accept: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      decision = resolve
    })
    const timer = setTimeout(() => {
      this.pending.delete(key)
      decision(false)
    }, this.options.timeoutMs ?? 120_000)
    this.pending.set(key, { key, promptId, promise, resolve: decision, timer })
    this.options.emit({
      promptId,
      host,
      port,
      fingerprint,
      kind: verdict === 'new' ? 'new' : 'changed',
      ...(previous !== undefined ? { previous } : {}),
    })
    const accepted = await promise
    if (accepted) await this.persist(host, port, fingerprint)
    return accepted
  }

  respond(promptId: string, accept: boolean): boolean {
    for (const entry of this.pending.values()) {
      if (entry.promptId !== promptId) continue
      clearTimeout(entry.timer)
      this.pending.delete(entry.key)
      // 指纹变化默认拒绝，只有显式 accept:true 才替换旧指纹。
      entry.resolve(accept === true)
      return true
    }
    return false
  }

  close(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve(false)
    }
    this.pending.clear()
  }

  private async persist(host: string, port: number, fingerprint: string): Promise<void> {
    // 重新读一次，避免覆盖 T8 导入旧指纹时并发写入的条目。
    const current = await readKnownHosts(this.options.userData)
    await writeKnownHosts(this.options.userData, setHostKey(current, host, port, fingerprint))
  }
}
