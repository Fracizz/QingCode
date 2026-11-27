import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commandNameFromRelativePath,
  dedupeAndSort,
  firstBodyLine,
  parseFrontmatter,
  scanSkills,
  SkillsCatalog,
  truncateDescription,
  type SkillEntry,
} from './skills'

describe('frontmatter 解析', () => {
  it('取 name/description，去引号，支持块标量与续行', () => {
    const { meta, body } = parseFrontmatter(
      '---\nname: "demo"\ndescription: >\n  第一行\n  第二行\nother: x\n---\n# 正文\n',
    )
    expect(meta.name).toBe('demo')
    expect(meta.description).toBe('第一行 第二行')
    expect(meta.other).toBe('x')
    expect(body).toBe('# 正文\n')
  })

  it('没有 frontmatter 时整个文本是正文；兼容 CRLF 与 BOM', () => {
    expect(parseFrontmatter('hello').meta).toEqual({})
    const parsed = parseFrontmatter('﻿---\r\nname: a\r\n---\r\nbody')
    expect(parsed.meta.name).toBe('a')
    expect(parsed.body).toBe('body')
  })

  it('正文首个非空行作为 description 兜底，并截断到 200 字', () => {
    expect(firstBodyLine('\n\n## 标题行\n其他')).toBe('标题行')
    expect(truncateDescription('x'.repeat(300))).toHaveLength(200)
  })
})

describe('命令名与去重', () => {
  it('子目录用冒号连接并去扩展名', () => {
    expect(commandNameFromRelativePath('review.md')).toBe('review')
    expect(commandNameFromRelativePath('frontend/review.md')).toBe('frontend:review')
    expect(commandNameFromRelativePath('a\\b\\c.md')).toBe('a:b:c')
  })

  it('同名先出现者优先，结果按 name 排序', () => {
    const mk = (name: string, scope: 'user' | 'repo'): SkillEntry => ({
      name,
      description: '',
      path: `/${scope}/${name}`,
      scope,
    })
    const out = dedupeAndSort([mk('b', 'repo'), mk('a', 'user'), mk('b', 'user')])
    expect(out.map((e) => `${e.name}:${e.scope}`)).toEqual(['a:user', 'b:repo'])
  })
})

describe('目录扫描', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'qn-skills-'))
    const home = join(root, 'home')
    const cwd = join(root, 'proj')
    await mkdir(join(home, '.claude', 'skills', 'u-skill'), { recursive: true })
    await writeFile(
      join(home, '.claude', 'skills', 'u-skill', 'SKILL.md'),
      '---\nname: shared\ndescription: 用户级\n---\nx',
    )
    await mkdir(join(home, '.claude', 'commands', 'frontend'), { recursive: true })
    await writeFile(join(home, '.claude', 'commands', 'frontend', 'review.md'), '# 审查前端\n细节')
    await mkdir(join(cwd, '.claude', 'skills', 'p-skill'), { recursive: true })
    await writeFile(
      join(cwd, '.claude', 'skills', 'p-skill', 'SKILL.md'),
      '---\nname: shared\ndescription: 项目级\n---\nx',
    )
    await mkdir(join(cwd, '.claude', 'skills', 'no-name'), { recursive: true })
    await writeFile(join(cwd, '.claude', 'skills', 'no-name', 'SKILL.md'), '正文首行')
    await mkdir(join(cwd, '.claude', 'skills', 'empty-dir'), { recursive: true })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('项目级优先，目录名兜底 name，命令带命名空间，缺失目录不报错', async () => {
    const result = await scanSkills(join(root, 'proj'), join(root, 'home'))
    expect(result.errors).toEqual([])
    const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]))
    expect(Object.keys(byName)).toEqual(['frontend:review', 'no-name', 'shared'])
    expect(byName.shared?.scope).toBe('repo')
    expect(byName.shared?.description).toBe('项目级')
    expect(byName['no-name']?.description).toBe('正文首行')
    expect(byName['frontend:review']).toMatchObject({ scope: 'user', description: '审查前端' })
  })

  it('SkillsCatalog 缓存结果，forceReload 才重扫', async () => {
    const catalog = new SkillsCatalog(join(root, 'home'))
    const cwd = join(root, 'proj')
    const first = (await catalog.list([cwd])) as { data: { skills: unknown[] }[] }
    expect(first.data[0]?.skills).toHaveLength(3)
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true })
    await writeFile(join(cwd, '.claude', 'commands', 'late.md'), 'late')
    const cached = (await catalog.list([cwd])) as { data: { skills: unknown[] }[] }
    expect(cached.data[0]?.skills).toHaveLength(3)
    const fresh = (await catalog.list([cwd], true)) as { data: { skills: Record<string, unknown>[] }[] }
    expect(fresh.data[0]?.skills).toHaveLength(4)
    expect(fresh.data[0]?.skills[0]).toMatchObject({ enabled: true, pluginId: null })
  })
})
