import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostKeyGate } from './hostKeyGate'
import { readKnownHosts, writeKnownHosts } from './hostKeys'

const dirs: string[] = []
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'qn-hostkey-gate-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function waitForPrompts(prompts: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while (prompts.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('HostKeyGate', () => {
  it('新主机弹确认，接受后写入 known_hosts，后续直接匹配', async () => {
    const dir = await tempDir()
    const prompts: Record<string, unknown>[] = []
    const gate = new HostKeyGate({ userData: dir, emit: (prompt) => prompts.push(prompt) })
    const first = gate.verify('192.168.10.93', 22, 'SHA256:new')
    await waitForPrompts(prompts, 1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ kind: 'new', fingerprint: 'SHA256:new' })
    expect(gate.respond(String(prompts[0]?.['promptId']), true)).toBe(true)
    await expect(first).resolves.toBe(true)
    expect(await readKnownHosts(dir)).toEqual({ '192.168.10.93:22': 'SHA256:new' })
    const second = gate.verify('192.168.10.93', 22, 'SHA256:new')
    await expect(second).resolves.toBe(true)
    expect(prompts).toHaveLength(1)
    gate.close()
  })

  it('指纹变化默认拒绝，只有明确确认才替换', async () => {
    const dir = await tempDir()
    await writeKnownHosts(dir, { 'h:22': 'SHA256:old' })
    const prompts: Record<string, unknown>[] = []
    const gate = new HostKeyGate({ userData: dir, emit: (prompt) => prompts.push(prompt), timeoutMs: 30 })
    await expect(gate.verify('h', 22, 'SHA256:new')).resolves.toBe(false)
    expect(prompts[0]).toMatchObject({ kind: 'changed', previous: 'SHA256:old' })
    expect(await readKnownHosts(dir)).toEqual({ 'h:22': 'SHA256:old' })

    const second = gate.verify('h', 22, 'SHA256:new')
    await waitForPrompts(prompts, 2)
    gate.respond(String(prompts[1]?.['promptId']), true)
    await expect(second).resolves.toBe(true)
    expect(await readKnownHosts(dir)).toEqual({ 'h:22': 'SHA256:new' })
    gate.close()
  })

  it('并发握手共用一次确认；autoAcceptNew 只自动接受新主机', async () => {
    const dir = await tempDir()
    const prompts: Record<string, unknown>[] = []
    const gate = new HostKeyGate({ userData: dir, emit: (prompt) => prompts.push(prompt) })
    const a = gate.verify('x', 22, 'SHA256:f1')
    const b = gate.verify('x', 22, 'SHA256:f1')
    await waitForPrompts(prompts, 1)
    expect(prompts).toHaveLength(1)
    gate.respond(String(prompts[0]?.['promptId']), false)
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBe(false)
    gate.close()

    const autoDir = await tempDir()
    const auto = new HostKeyGate({
      userData: autoDir,
      emit: () => {},
      autoAcceptNew: true,
      timeoutMs: 30,
    })
    await expect(auto.verify('y', 22, 'SHA256:f2')).resolves.toBe(true)
    expect(await readKnownHosts(autoDir)).toEqual({ 'y:22': 'SHA256:f2' })
    await expect(auto.verify('y', 22, 'SHA256:changed')).resolves.toBe(false)
    auto.close()
  })

  it('未知 promptId 不影响未决确认', () => {
    const gate = new HostKeyGate({ userData: 'unused', emit: () => {} })
    expect(gate.respond('nope', true)).toBe(false)
    gate.close()
  })
})
