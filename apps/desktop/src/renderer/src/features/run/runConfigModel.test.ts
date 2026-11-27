import { describe, expect, it } from 'vitest'
import {
  configTasksFor,
  configToDraft,
  createConfig,
  discoverCargo,
  discoverMakeTargets,
  discoverPackageScripts,
  discoverPython,
  draftToConfig,
  draftToTask,
  duplicateConfig,
  importDiscovered,
  isConfigPath,
  isDiscoveredImported,
  parseRunConfigFile,
  pyprojectScripts,
  removeConfig,
  resolveTask,
  runConfigPaths,
  samePath,
  serializeRunConfigFile,
  stripRedundantCdPrefix,
  taskToDraft,
  uniqueName,
  upsertConfig,
  validateDraft,
  type RunConfig,
  type RunTask,
} from './runConfigModel'

// 旧版 CLI `qingcode run upsert` 写出的文件（serde to_string_pretty + 换行）。
const LEGACY_CLI = `{
  "configs": [
    {
      "id": "c1",
      "name": "dev",
      "restoreWithProjectSession": false,
      "tasks": [
        {
          "id": "api",
          "type": "command",
          "target": "",
          "os": {
            "windows": { "target": "python.exe app.py", "env": { "MODE": "win" } },
            "linux": { "target": "python3 app.py", "cwd": "" },
            "macos": { "type": "sh", "target": "dev.sh" }
          }
        },
        { "id": "web", "name": "前端", "type": "command", "target": "pnpm dev", "cwd": "web", "env": { "PORT": "3000" } }
      ]
    }
  ]
}
`

describe('解析与序列化', () => {
  it('读旧版 CLI 写出的文件', () => {
    const parsed = parseRunConfigFile(LEGACY_CLI)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const config = parsed.file.configs[0]!
    expect(config.name).toBe('dev')
    expect(config.tasks[0]!.os).toEqual({
      windows: { target: 'python.exe app.py', env: { MODE: 'win' } },
      linux: { target: 'python3 app.py', cwd: '' },
      macos: { type: 'sh', target: 'dev.sh' },
    })
    expect(config.tasks[1]).toMatchObject({ name: '前端', target: 'pnpm dev', cwd: 'web', env: { PORT: '3000' } })
  })

  it('原样往返（字段顺序与旧版一致）', () => {
    const parsed = parseRunConfigFile(LEGACY_CLI)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(JSON.parse(serializeRunConfigFile(parsed.file))).toEqual(JSON.parse(LEGACY_CLI))
    expect(serializeRunConfigFile(parsed.file).endsWith('\n')).toBe(true)
  })

  it('保留未知字段与无法识别的条目', () => {
    const text = JSON.stringify({
      version: 2,
      configs: [
        { id: 'a', name: 'A', color: 'red', tasks: [{ id: 't', target: 'x', pinned: true }, { bogus: 1 }] },
        { name: '缺 id' },
      ],
    })
    const parsed = parseRunConfigFile(text)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.configs).toHaveLength(1)
    const out = JSON.parse(serializeRunConfigFile(parsed.file))
    expect(out.version).toBe(2)
    expect(out.configs[0].color).toBe('red')
    expect(out.configs[0].tasks).toEqual([
      { id: 't', type: 'command', target: 'x', pinned: true },
      { bogus: 1 },
    ])
    expect(out.configs[1]).toEqual({ name: '缺 id' })
  })

  it('BOM、空文件、格式错误', () => {
    expect(parseRunConfigFile('\uFEFF{"configs":[]}').ok).toBe(true)
    expect(parseRunConfigFile('  ')).toEqual({ ok: true, file: { configs: [] } })
    expect(parseRunConfigFile('{oops').ok).toBe(false)
    expect(parseRunConfigFile('{"configs":{}}')).toEqual({ ok: false, error: 'configs 必须是数组' })
    expect(parseRunConfigFile('[]').ok).toBe(false)
  })

  it('未知 type 回退为 command，os 字符串写法也接受', () => {
    const parsed = parseRunConfigFile(
      JSON.stringify({ configs: [{ id: 'a', name: 'A', tasks: [{ id: 't', type: 'exe', target: 'x', os: 'linux' }] }] }),
    )
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.configs[0]!.tasks[0]).toMatchObject({ type: 'command', os: 'linux' })
  })
})

describe('按系统解析任务', () => {
  const parsed = parseRunConfigFile(LEGACY_CLI)
  if (!parsed.ok) throw new Error(parsed.error)
  const config = parsed.file.configs[0]!

  it('合并 os 覆盖', () => {
    expect(resolveTask(config.tasks[0]!, 'windows')).toEqual({
      ok: true,
      task: { type: 'command', target: 'python.exe app.py', env: { MODE: 'win' } },
    })
    expect(resolveTask(config.tasks[0]!, 'macos')).toEqual({ ok: true, task: { type: 'sh', target: 'dev.sh' } })
    // 覆盖里的空 cwd 等于不设工作目录。
    expect(resolveTask(config.tasks[0]!, 'linux')).toEqual({ ok: true, task: { type: 'command', target: 'python3 app.py' } })
  })

  it('字符串 os 限制、缺 target、BAT 非 Windows', () => {
    const only: RunTask = { id: 'x', type: 'command', target: 'a', os: 'windows' }
    expect(resolveTask(only, 'linux').ok).toBe(false)
    expect(resolveTask(only, 'windows').ok).toBe(true)
    expect(resolveTask({ id: 'y', type: 'command', target: '' }, 'linux')).toMatchObject({ ok: false })
    expect(resolveTask({ id: 'z', type: 'bat', target: 'a.bat' }, 'macos')).toMatchObject({ ok: false })
  })

  it('有 cwd 时去掉多余的 cd 前缀', () => {
    expect(stripRedundantCdPrefix('cd web && pnpm dev')).toBe('pnpm dev')
    expect(resolveTask({ id: 'a', type: 'command', target: 'cd "my web"; npm start', cwd: 'web' }, 'linux')).toMatchObject({
      task: { target: 'npm start' },
    })
  })

  it('configTasksFor 分出可运行与跳过', () => {
    const mixed: RunConfig = {
      id: 'c',
      name: 'c',
      tasks: [
        { id: 'a', type: 'command', target: 'x' },
        { id: 'b', type: 'bat', target: 'b.bat' },
      ],
    }
    const result = configTasksFor(mixed, 'linux')
    expect(result.runnable.map((r) => r.task.id)).toEqual(['a'])
    expect(result.skipped[0]!.reason).toContain('BAT')
  })
})

describe('新建 / 复制 / 删除', () => {
  it('名称去重、复制换新 id', () => {
    const a = createConfig([])
    expect(a.name).toBe('新配置')
    expect(createConfig([a]).name).toBe('新配置 2')
    const copy = duplicateConfig([a], a)
    expect(copy.id).not.toBe(a.id)
    expect(copy.tasks[0]!.id).not.toBe(a.tasks[0]!.id)
    expect(copy.name).toBe('新配置 副本')
    expect(uniqueName([a, copy], '新配置 副本')).toBe('新配置 副本 2')
  })

  it('upsert 与 remove', () => {
    const a: RunConfig = { id: 'a', name: 'A', tasks: [] }
    const b: RunConfig = { id: 'b', name: 'B', tasks: [] }
    expect(upsertConfig([a], b).map((c) => c.id)).toEqual(['a', 'b'])
    expect(upsertConfig([a, b], { ...a, name: 'A2' })[0]!.name).toBe('A2')
    expect(removeConfig([a, b], 'a')).toEqual([b])
  })
})

describe('编辑器草稿', () => {
  it('单系统覆盖转成系统限制，保存时写回旧版格式', () => {
    const task: RunTask = { id: 't', type: 'command', target: '', os: { windows: { target: 'run.bat', type: 'bat', env: { A: '1' } } } }
    const draft = taskToDraft(task)
    expect(draft).toMatchObject({ restriction: 'windows', type: 'bat', target: 'run.bat', env: [{ key: 'A', value: '1' }] })
    expect(draft.overrides).toBeUndefined()
    expect(draftToTask(draft)).toEqual({
      id: 't',
      type: 'bat',
      target: '',
      os: { windows: { type: 'bat', target: 'run.bat', env: { A: '1' } } },
    })
  })

  it('多系统覆盖原样保留', () => {
    const task: RunTask = { id: 't', type: 'command', target: 'x', os: { windows: { target: 'a' }, linux: { target: 'b' } } }
    const draft = taskToDraft(task)
    expect(draft.restriction).toBe('all')
    expect(draftToTask(draft).os).toEqual(task.os)
  })

  it('配置级未知字段与无法识别的任务在编辑后保留', () => {
    const config: RunConfig = { id: 'c', name: 'n', tasks: [{ id: 't', type: 'command', target: 'x', extra: { k: 1 } }], extra: { color: 'red' }, rawTasks: [{ x: 1 }] }
    const back = draftToConfig({ ...configToDraft(config), name: ' 新名 ' })
    expect(back).toMatchObject({ name: '新名', extra: { color: 'red' }, rawTasks: [{ x: 1 }] })
    expect(back.tasks[0]!.extra).toEqual({ k: 1 })
  })

  it('校验名称、重名、命令、环境变量', () => {
    const other: RunConfig = { id: 'o', name: 'dev', tasks: [] }
    const draft = configToDraft({ id: 'c', name: 'dev', tasks: [{ id: 't', type: 'command', target: '' }] })
    draft.tasks[0]!.env = [{ key: 'A', value: '1' }, { key: 'A', value: '2' }, { key: 'B=C', value: '' }, { key: '', value: 'x' }]
    const errors = validateDraft(draft, [other])
    expect(errors.some((e) => e.includes('同名'))).toBe(true)
    expect(errors.some((e) => e.includes('请填写命令'))).toBe(true)
    expect(errors.some((e) => e.includes('重复'))).toBe(true)
    expect(errors.some((e) => e.includes('无效'))).toBe(true)
    expect(errors.some((e) => e.includes('不能为空'))).toBe(true)
    const ok = configToDraft({ id: 'c', name: 'x', tasks: [{ id: 't', type: 'command', target: 'pnpm dev' }] })
    expect(validateDraft(ok, [other])).toEqual([])
    expect(validateDraft({ ...ok, name: ' ' }, [])).toContain('请填写配置名称')
  })
})

describe('自动发现', () => {
  it('package.json scripts 按锁文件选包管理器', () => {
    const found = discoverPackageScripts(
      JSON.stringify({ scripts: { dev: 'vite', 'build:web': 'tsc', 'bad name': 'x', empty: '' } }),
      { cwd: '', fileNames: ['pnpm-lock.yaml'] },
    )
    expect(found.manager).toBe('pnpm')
    expect(found.tasks.map((t) => t.task.target)).toEqual(['pnpm run dev', 'pnpm run build:web'])
    expect(found.warnings[0]!.message).toContain('bad name')
    const child = discoverPackageScripts(JSON.stringify({ scripts: { start: 'node .' } }), {
      cwd: 'server',
      fileNames: [],
      inherited: 'yarn',
    })
    expect(child.tasks[0]).toMatchObject({ name: 'server: start', task: { target: 'yarn run start', cwd: 'server' } })
    const explicit = discoverPackageScripts(JSON.stringify({ packageManager: 'bun@1.1.0', scripts: { a: 'b' } }), {
      cwd: '',
      fileNames: ['package-lock.json'],
    })
    expect(explicit.manager).toBe('bun')
    expect(discoverPackageScripts('{bad', { cwd: '', fileNames: [] }).warnings).toHaveLength(1)
  })

  it('Makefile 目标', () => {
    const text = '.PHONY: build\nVAR := 1\nX ::= 2\nbuild test: deps\n\tcc\n%.o: %.c\nrun:\n'
    expect(discoverMakeTargets(text).map((t) => t.task.target)).toEqual(['make build', 'make test', 'make run'])
  })

  it('Cargo.toml', () => {
    expect(discoverCargo('[package]\nname="a"').map((t) => t.task.target)).toEqual(['cargo run', 'cargo test'])
    expect(discoverCargo('[workspace]\nmembers=[]').map((t) => t.task.target)).toEqual(['cargo test'])
    expect(discoverCargo('# empty')).toEqual([])
  })

  it('Python：manage.py、pyproject scripts、pytest', () => {
    const pyproject = '[project]\nname="x"\n[project.scripts]\nserve = "x:main"\n"cli" = "x:cli"\n[tool.pytest.ini_options]\n'
    expect(pyprojectScripts(pyproject)).toEqual(['serve', 'cli'])
    const linux = discoverPython({ fileNames: ['manage.py'], pyproject, os: 'linux' })
    expect(linux.map((t) => t.task.target)).toEqual([
      'python3 manage.py runserver',
      'python3 manage.py test',
      'serve',
      'cli',
      'python3 -m pytest',
    ])
    const uv = discoverPython({ fileNames: ['manage.py', 'uv.lock'], pyproject: null, os: 'windows' })
    expect(uv[0]!.task.target).toBe('uv run python manage.py runserver')
  })

  it('去重与导入', () => {
    const configs: RunConfig[] = [{ id: 'c', name: 'dev', tasks: [{ id: 't', type: 'command', target: 'pnpm run dev', cwd: './' }] }]
    const found = discoverPackageScripts(JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } }), {
      cwd: '',
      fileNames: ['pnpm-lock.yaml'],
    }).tasks
    expect(isDiscoveredImported(found[0]!, configs)).toBe(true)
    expect(isDiscoveredImported(found[1]!, configs)).toBe(false)
    const separate = importDiscovered(configs, found, false)
    expect(separate.map((c) => c.name)).toEqual(['dev', 'test'])
    const combined = importDiscovered(configs, [...found, { ...found[1]!, key: 'k2', name: 'lint', task: { type: 'command', target: 'pnpm run lint' } }], true)
    expect(combined).toHaveLength(2)
    expect(combined[1]!.tasks).toHaveLength(2)
    expect(combined[1]!.name).toBe('test + lint')
    expect(importDiscovered(configs, [found[0]!], false)).toBe(configs)
  })
})

describe('路径', () => {
  it('按项目根的分隔符拼路径', () => {
    expect(runConfigPaths('D:\\code\\app\\')).toEqual({
      dir: 'D:\\code\\app\\.qingcode',
      file: 'D:\\code\\app\\.qingcode\\run.json',
      legacyFile: 'D:\\code\\app\\.nestcode\\run.json',
    })
    expect(runConfigPaths('/srv/app').file).toBe('/srv/app/.qingcode/run.json')
  })

  it('samePath 与 isConfigPath', () => {
    expect(samePath('D:\\Code\\App\\', 'd:/code/app')).toBe(true)
    expect(samePath('/srv/App', '/srv/app')).toBe(false)
    expect(isConfigPath('D:\\app', 'd:\\APP\\.qingcode\\run.json')).toBe(true)
    expect(isConfigPath('/srv/app', '/srv/app/.qingcode')).toBe(true)
    expect(isConfigPath('/srv/app', '/srv/app/.nestcode/run.json')).toBe(true)
    expect(isConfigPath('/srv/app', '/srv/app/src/a.ts')).toBe(false)
    expect(isConfigPath('/srv/app', '/srv/app/.qingcodex')).toBe(false)
  })
})
