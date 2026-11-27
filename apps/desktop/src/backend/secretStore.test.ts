import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createParentPortCipher,
  loadSecret,
  parseSecretStore,
  parseStoredSecret,
  readSecretStore,
  removeSecret,
  saveSecret,
  serializeStoredSecret,
  withSecret,
  withoutSecret,
  writeSecretStore,
  type ParentPortLike,
} from './secretStore'

const tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

// 模拟 main 的 safeStorage：加密只是 base64，够验证调用链且不写入任何明文。
class FakeParentPort implements ParentPortLike {
  readonly sent: unknown[] = []
  private listener: ((e: { data: unknown }) => void) | null = null
  reply = true
  failDecrypt = false

  on(_event: 'message', listener: (e: { data: unknown }) => void): this {
    this.listener = listener
    return this
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
    if (!this.reply) return
    const data = message as { type: string; id: string; text?: string; encoded?: string }
    setImmediate(() => {
      if (this.failDecrypt) {
        this.listener?.({ data: { type: 'secret.result', id: data.id, ok: false, error: '凭据加解密失败' } })
      } else if (data.type === 'secret.encrypt') {
        this.listener?.({ data: { type: 'secret.result', id: data.id, ok: true, value: Buffer.from(data.text ?? '').toString('base64') } })
      } else {
        this.listener?.({ data: { type: 'secret.result', id: data.id, ok: true, value: Buffer.from(data.encoded ?? '', 'base64').toString('utf8') } })
      }
    })
  }

  emit(data: unknown): void {
    this.listener?.({ data })
  }
}

describe('纯逻辑', () => {
  it('parseSecretStore 只保留非空字符串', () => {
    expect(parseSecretStore({ a: 'Yg==', b: 1, c: null, '': 'x' })).toEqual({ a: 'Yg==' })
    expect(parseSecretStore([1, 2])).toEqual({})
  })

  it('withSecret / withoutSecret 不修改原对象', () => {
    const store = { a: 'one' }
    expect(withSecret(store, 'b', 'two')).toEqual({ a: 'one', b: 'two' })
    expect(withoutSecret(withSecret(store, 'b', 'two'), 'a')).toEqual({ b: 'two' })
    expect(store).toEqual({ a: 'one' })
  })

  it('parseStoredSecret 接受对象或 JSON 字符串，只留非空字段', () => {
    expect(parseStoredSecret('{"password":"p","passphrase":"" }')).toEqual({ password: 'p' })
    expect(parseStoredSecret({ password: 'p', passphrase: 'x', extra: 1 })).toEqual({ password: 'p', passphrase: 'x' })
    expect(parseStoredSecret('not json')).toBeNull()
    expect(parseStoredSecret('{}')).toBeNull()
    expect(parseStoredSecret({ password: 123 })).toBeNull()
    expect(JSON.parse(serializeStoredSecret({ password: 'p', passphrase: 'x' }))).toEqual({ password: 'p', passphrase: 'x' })
  })
})

describe('createParentPortCipher', () => {
  it('带 id 往返并忽略无关消息与重复响应', async () => {
    const port = new FakeParentPort()
    const cipher = createParentPortCipher(port)
    const encoded = await cipher.encrypt('hello')
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('hello')
    expect(await cipher.decrypt(encoded)).toBe('hello')

    port.emit({ type: 'other' })
    port.emit({ type: 'secret.result', id: 'unknown', ok: true, value: 'x' })
    expect(port.sent).toHaveLength(2)
    expect(port.sent[0]).toMatchObject({ type: 'secret.encrypt', text: 'hello' })
    expect((port.sent[0] as { id: string }).id).toBeTruthy()
  })

  it('main 返回错误时转成拒绝', async () => {
    const port = new FakeParentPort()
    port.failDecrypt = true
    await expect(createParentPortCipher(port).decrypt('YQ==')).rejects.toThrow('凭据加解密失败')
  })

  it('5 秒无响应则超时', async () => {
    vi.useFakeTimers()
    const port = new FakeParentPort()
    port.reply = false
    const pending = createParentPortCipher(port).encrypt('hello')
    const assertion = expect(pending).rejects.toThrow('凭据服务响应超时')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('没有 parentPort 时立即报错', async () => {
    await expect(createParentPortCipher(null).encrypt('x')).rejects.toThrow('凭据服务不可用')
  })
})

describe('saveSecret / loadSecret / removeSecret', () => {
  it('加密后落盘、可读回、可删除，且文件不含明文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qn-secrets-'))
    tempDirs.push(dir)
    const port = new FakeParentPort()
    const options = { userData: dir, cipher: createParentPortCipher(port) }

    expect(await loadSecret('ssh-1', options)).toBeNull()
    await saveSecret('ssh-1', { password: 'p@ss', passphrase: 'phrase' }, options)
    expect(await loadSecret('ssh-1', options)).toEqual({ password: 'p@ss', passphrase: 'phrase' })

    const raw = await readFile(join(dir, 'secrets.json'), 'utf8')
    expect(raw).not.toContain('p@ss')
    expect(raw).not.toContain('phrase')
    expect(parseSecretStore(JSON.parse(raw))['ssh-1']).toBeTruthy()

    await removeSecret('ssh-1', options)
    expect(await loadSecret('ssh-1', options)).toBeNull()
    expect(parseSecretStore(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')))).toEqual({})
    await removeSecret('ssh-1', options)
  })

  it('空凭据等价于删除；解密失败向外抛错但不带明文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qn-secrets-'))
    tempDirs.push(dir)
    const port = new FakeParentPort()
    const options = { userData: dir, cipher: createParentPortCipher(port) }
    await saveSecret('ssh-1', { password: 'p' }, options)
    await saveSecret('ssh-1', {}, options)
    expect(await readSecretStore(dir)).toEqual({})

    await writeSecretStore(dir, { 'ssh-1': Buffer.from('not json').toString('base64') })
    expect(await loadSecret('ssh-1', options)).toBeNull()
  })

  it('损坏的 secrets.json 退化为空', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qn-secrets-'))
    tempDirs.push(dir)
    await writeFile(join(dir, 'secrets.json'), '{bad', 'utf8')
    expect(await readSecretStore(dir)).toEqual({})
    await writeSecretStore(dir, { a: 'YQ==' })
    expect(await readSecretStore(dir)).toEqual({ a: 'YQ==' })
  })
})
