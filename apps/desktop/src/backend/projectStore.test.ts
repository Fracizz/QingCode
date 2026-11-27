import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  basenameOf,
  createProjectId,
  listProjects,
  normalizeProjectPath,
  normalizeProjects,
  projectKey,
  readProjects,
  removeProject,
  serializeProjects,
  sortProjects,
  upsertProject,
  writeProjects,
} from './projectStore'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const project = (id: string, targetId: string, path: string, lastOpenedAt = 1) => ({
  id,
  targetId,
  name: `${id}-name`,
  path,
  lastOpenedAt,
})

describe('basenameOf / normalizeProjectPath', () => {
  it('同时处理 Windows 与 POSIX 路径', () => {
    expect(basenameOf('C:\\work\\my-app\\')).toBe('my-app')
    expect(basenameOf('/home/user/my-app')).toBe('my-app')
    expect(basenameOf('/')).toBe('/')
    expect(normalizeProjectPath('/home/user/my-app/')).toBe('/home/user/my-app')
    expect(normalizeProjectPath('C:\\work\\')).toBe('C:\\work')
    expect(projectKey('local', 'C:\\work\\')).toBe(projectKey('local', 'C:\\work'))
  })
})

describe('normalizeProjects', () => {
  it('过滤无效条目、按 targetId+path 去重、补默认 name', () => {
    const result = normalizeProjects([
      project('a', 'local', 'C:\\work\\app', 10),
      { ...project('b', 'local', 'C:\\work\\app\\', 99), extra: 'drop' },
      { id: 'c', targetId: 'local', name: '', path: '/srv/demo', lastOpenedAt: 5 },
      null,
      { id: 'd', targetId: '', path: 'x' },
      { id: 'e', targetId: 'local', path: '' },
      { ...project('f', 'ssh-1', '/srv/f'), lastOpenedAt: 'bad' },
    ])
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      id: 'a', targetId: 'local', name: 'a-name', path: 'C:\\work\\app', lastOpenedAt: 10,
    })
    expect(result.find((p) => p.id === 'c')?.name).toBe('demo')
    expect(result.find((p) => p.id === 'f')?.lastOpenedAt).toBe(0)
    expect(result.map((p) => p.lastOpenedAt)).toEqual([10, 5, 0])
  })

  it('非数组输入退化为空数组', () => {
    expect(normalizeProjects({ foo: 1 })).toEqual([])
  })
})

describe('sortProjects / listProjects', () => {
  it('按 lastOpenedAt 降序，可按目标过滤', () => {
    const list = [project('a', 'local', 'p1', 1), project('b', 'ssh-1', 'p2', 30), project('c', 'local', 'p3', 20)]
    expect(sortProjects(list).map((p) => p.id)).toEqual(['b', 'c', 'a'])
    expect(listProjects(list, 'local').map((p) => p.id)).toEqual(['c', 'a'])
  })
})

describe('upsertProject / removeProject', () => {
  it('新增用生成 id；同 targetId+path 更新时保留 id 与名称并刷新时间', () => {
    const first = upsertProject([], { targetId: 'local', path: '/srv/demo/' }, 'p-new', 100)
    expect(first.project).toEqual({
      id: 'p-new', targetId: 'local', name: 'demo', path: '/srv/demo', lastOpenedAt: 100,
    })

    const updated = upsertProject(
      first.projects,
      { targetId: 'local', path: '/srv/demo', name: '改名' },
      'ignored',
      200
    )
    expect(updated.projects).toHaveLength(1)
    expect(updated.project.id).toBe('p-new')
    expect(updated.project.name).toBe('改名')
    expect(updated.project.lastOpenedAt).toBe(200)
  })

  it('显式 lastOpenedAt 保留旧版时间戳；指定 id 时按 id 更新', () => {
    const result = upsertProject(
      [],
      { id: 'legacy-1', targetId: 'local', path: 'D:\\p', lastOpenedAt: 1_700_000_000_000 },
      'ignored',
      Date.now()
    )
    expect(result.project.lastOpenedAt).toBe(1_700_000_000_000)
    expect(createProjectId()).toMatch(/^project-/)
  })

  it('路径或目标为空时抛错；删除按 id', () => {
    expect(() => upsertProject([], { targetId: 'local', path: '  ' }, 'x')).toThrow()
    expect(() => upsertProject([], { targetId: '', path: '/p' }, 'x')).toThrow()
    const list = normalizeProjects([project('a', 'local', 'p1'), project('b', 'local', 'p2')])
    expect(removeProject(list, 'a').map((p) => p.id)).toEqual(['b'])
  })
})

describe('serializeProjects', () => {
  it('只写白名单字段', () => {
    const withPassword = { ...project('a', 'local', 'p', 3), password: 'never' }
    const text = serializeProjects([withPassword])
    expect(text).not.toContain('never')
    expect(JSON.parse(text)).toEqual([project('a', 'local', 'p', 3)])
  })
})

describe('readProjects / writeProjects', () => {
  it('原子写可读回，缺文件与损坏文件都返回空数组', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qn-projects-'))
    tempDirs.push(dir)
    expect(await readProjects(dir)).toEqual([])

    const list = upsertProject([], { targetId: 'local', path: '/srv/demo' }, 'p1').projects
    await writeProjects(dir, list)
    expect(await readProjects(dir)).toEqual(list)
    expect((await readdir(dir)).sort()).toEqual(['projects.json'])

    await writeFile(join(dir, 'projects.json'), '{bad json', 'utf8')
    expect(await readProjects(dir)).toEqual([])
    await writeProjects(dir, list)
    expect(JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8'))).toEqual(list)
  })
})
