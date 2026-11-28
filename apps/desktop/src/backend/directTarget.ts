import { createHash } from 'node:crypto'
import tls from 'node:tls'
import { normalizeFingerprint } from '@qn/protocol'
import { ServerClient, toFramedStream } from './serverClient'
import type { DirectLinkContext, TargetLink } from './types'

const CONNECT_TIMEOUT_MS = 10_000

export class FingerprintMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`服务端证书指纹不符（期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…），已拒绝连接`)
    this.name = 'FingerprintMismatchError'
  }
}

/** 自签证书不走 CA 校验，改为固定证书 DER 的 SHA-256；不符直接断开，绝不发送 token。 */
export function openPinnedTls(host: string, port: number, fingerprint: string, timeoutMs = CONNECT_TIMEOUT_MS, signal?: AbortSignal): Promise<tls.TLSSocket> {
  const expected = normalizeFingerprint(fingerprint)
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      reject(err)
    }
    const abort = () => fail(signal?.reason)
    const timer = setTimeout(() => fail(new Error(`连接 ${host}:${String(port)} 超时`)), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const actual = cert?.raw ? createHash('sha256').update(cert.raw).digest('hex') : ''
      if (actual !== expected) {
        fail(new FingerprintMismatchError(expected, actual))
        return
      }
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 30_000)
      resolve(socket)
    })
    socket.once('error', (err: Error) => fail(new Error(`连接 ${host}:${String(port)} 失败: ${err.message}`)))
  })
}

export async function connectDirectTarget(context: DirectLinkContext): Promise<TargetLink> {
  const { target, signal } = context
  context.hooks.onState('connecting', `直连 ${target.host}:${String(target.port)}`)
  const socket = await openPinnedTls(target.host, target.port, target.fingerprint, context.connectTimeoutMs, signal)
  const abort = () => { socket.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    const server = await ServerClient.connect({
      stream: toFramedStream(socket),
      token: context.token,
      clientVersion: context.appVersion,
      requestTimeoutMs: 60_000,
      handlers: {
        onEvent: context.hooks.onEvent,
        onCodexRecv: context.hooks.onCodexRecv,
        onClose: context.hooks.onClose,
      },
    })
    return {
      viaDirect: true,
      server: { pid: server.pid, version: server.serverVersion },
      request: (method, params) => server.request(method, params),
      codexSend: (msg, agent) => server.codexSend(msg, agent),
      close: () => {
        server.close()
        socket.destroy()
      },
    }
  } catch (err) {
    socket.destroy()
    throw err
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
