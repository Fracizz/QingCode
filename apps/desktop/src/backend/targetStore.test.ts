import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeTargets,
  readTargets,
  removeTarget,
  serializeTargets,
  upsertTarget,
  writeTargets,
} from './targetStore'

const ssh = (id: string, host: string) => ({
  id,
  kind: 'ssh' as const,
  name: `${id}-name`,
  host,
  port: 22,
  username: 'root',
  auth: { kind: 'password' as const },
})

const ids = (targets: readonly { id: string }[]): string[] => targets.map((t) => t.id)

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('normalizeTargets', () => {
  it('本机永远在首位，且忽略无效条目与重复 id', () => {
    const result = normalizeTargets([
      ssh('a', '10.0.0.1'),
      { id: 'b', kind: 'ssh', name: 'x', host: 'h', port: 22, username: 'u', auth: { kind: 'password' }, password: 'secret' },
      ssh('a', '10.0.0.2'),
      { id: 'c', kind: 'ssh', name: 'x', host: 'h', port: '22', username: 'u', auth: { kind: 'agent' } },
      { id: 'local', kind: 'local', name: '伪造本机' },
      null,
    ])
    expect(ids(result)).toEqual(['local', 'a', 'b'])
    expect(result[0]).toEqual({ id: 'local', kind: 'local', name: '本机' })
    expect(result[2]).toEqual({
      id: 'b',
      kind: 'ssh',
      name: 'x',
      host: 'h',
      port: 22,
      username: 'u',
      auth: { kind: 'password' },
    })
  })

  it('非数组输入退化为只有本机', () => {
    expect(normalizeTargets({ foo: 1 })).toHaveLength(1)
  })
})

describe('serializeTargets', () => {
  it('只写 SSH 目标，不写本机，也不带密码字段', () => {
    const withPassword = { ...ssh('a', '10.0.0.1'), password: 'never-store' }
    const text = serializeTargets([
      { id: 'local', kind: 'local', name: '本机' },
      withPassword,
    ])
    expect(text).not.toContain('never-store')
    expect(text).not.toContain('local')
    expect(JSON.parse(text)).toHaveLength(1)
  })
})

describe('upsertTarget / removeTarget', () => {
  it('新增使用生成的 id，更新按 id 原位替换', () => {
    const first = upsertTarget(normalizeTargets([]), ssh('', '10.0.0.1'), 'ssh-new')
    expect(first.target.id).toBe('ssh-new')
    expect(ids(first.targets)).toEqual(['local', 'ssh-new'])

    const updated = upsertTarget(
      first.targets,
      { ...ssh('', '10.0.0.2'), id: 'ssh-new', name: '改名' },
      'ignored'
    )
    const item = updated.targets[1]
    expect(ids(updated.targets)).toEqual(['local', 'ssh-new'])
    expect(item?.name).toBe('改名')
    expect(item?.kind === 'ssh' ? item.host : null).toBe('10.0.0.2')
  })

  it('私钥认证保留 keyPath', () => {
    const result = upsertTarget(
      normalizeTargets([]),
      { ...ssh('', '10.0.0.1'), auth: { kind: 'key', keyPath: 'C:\\keys\\id_ed25519' } },
      'ssh-key'
    )
    const item = result.targets[1]
    expect(item?.kind === 'ssh' ? item.auth : null).toEqual({
      kind: 'key',
      keyPath: 'C:\\keys\\id_ed25519',
    })
  })

  it('删除 SSH 目标时本机始终保留', () => {
    const list = upsertTarget(normalizeTargets([]), ssh('', '10.0.0.1'), 'a').targets
    expect(ids(removeTarget(list, 'a'))).toEqual(['local'])
    expect(ids(removeTarget(list, 'local'))).toEqual(['local', 'a'])
  })
})

describe('readTargets / writeTargets', () => {
  it('落盘后可读回，缺文件与损坏文件都退回只有本机', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qn-targets-'))
    tempDirs.push(dir)
    expect(ids(await readTargets(dir))).toEqual(['local'])

    const list = upsertTarget(normalizeTargets([]), ssh('', '10.0.0.1'), 'a').targets
    await writeTargets(dir, list)
    expect(ids(await readTargets(dir))).toEqual(['local', 'a'])

    await writeFile(join(dir, 'targets.json'), '{bad json', 'utf8')
    expect(ids(await readTargets(dir))).toEqual(['local'])
  })
})
