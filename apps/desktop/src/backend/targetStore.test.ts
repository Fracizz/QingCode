import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeTargets,
  readTargets,
  removeTarget,
  serializeTargets,
  setSshDirect,
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

describe('setSshDirect', () => {
  const direct = { host: '10.0.0.5', port: 47390, fingerprint: 'a'.repeat(64), grantId: 'g' }

  it('设置、保留（编辑表单时）与清除直连配置', () => {
    const base = normalizeTargets([ssh('a', 'h1')])
    const set = setSshDirect(base, 'a', direct)
    expect(set?.target.direct).toEqual(direct)
    // 编辑连接信息不应丢掉直连配置。
    const edited = upsertTarget(set?.targets ?? [], { id: 'a', name: 'n', host: 'h2', port: 22, username: 'r', auth: { kind: 'agent' } }, 'x')
    expect(edited.target.direct).toEqual(direct)
    // 落盘再读回仍在。
    expect(normalizeTargets(JSON.parse(serializeTargets(edited.targets)))[1]).toMatchObject({ direct })
    const cleared = setSshDirect(edited.targets, 'a', undefined)
    expect(cleared?.target.direct).toBeUndefined()
    expect(setSshDirect(base, 'missing', direct)).toBeNull()
  })

  it('丢弃格式不对的直连配置', () => {
    const [, parsed] = normalizeTargets([{ ...ssh('a', 'h'), direct: { host: 'x', port: 1, fingerprint: 'bad', grantId: 'g' } }])
    expect(parsed).not.toHaveProperty('direct')
  })
})
