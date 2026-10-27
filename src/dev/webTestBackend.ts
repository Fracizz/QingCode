import type { SqlValue } from 'sql.js'
import type { WebTestDatabase } from './webTestDatabase'
import {
  WebTestFileSystem,
  normalizeTestPath,
  pathWithin,
  testParent,
  type TestEntries,
} from './webTestFileSystem'
import { isPathExcluded } from '../lib/excludeSettings'
import type { SshServerPhase, SshServerState } from '../lib/sshServerStatus'

type Args = Record<string, unknown>
type Terminal = { cwd: string; input: string; connected: boolean; script: boolean }
type Connection = { mode: string; connected: boolean }
export type TestEventEmitter = (event: string, payload: unknown) => void

export const TEST_ROOT = '/workspace/demo'
export const TEST_REMOTE_ROOT = 'ssh://web-test/home/demo'
export const TEST_SETTINGS = '/app/default-settings.json'
export const TEST_DB = 'sqlite:web-test.db'
export const TEST_FINGERPRINT = 'SHA256:QingCodeWebTestFixtureOnly'

export function initialTestEntries(): TestEntries {
  const entries: TestEntries = {}
  const add = (path: string, directory: boolean, content = '') => {
    entries[path] = { directory, content, mtime: 1 }
  }
  for (const path of [
    '/',
    '/workspace',
    TEST_ROOT,
    `${TEST_ROOT}/src`,
    '/workspace/other',
    '/app',
    '/tmp',
    'ssh://web-test/home',
    TEST_REMOTE_ROOT,
  ])
    add(path, true)
  add(`${TEST_ROOT}/README.md`, false, '# QingCode Web test\n\nEdit, save and reopen this file.\n')
  add(`${TEST_ROOT}/src/main.ts`, false, 'export const message = "Hello QingCode"\n')
  add(`${TEST_REMOTE_ROOT}/README.md`, false, '# Simulated SSH workspace\n')
  add(
    TEST_SETTINGS,
    false,
    '{\n // 测试设置，不得删除注释\n "version": 1,\n "qingcode.update.checkOnStartup": false,\n "custom": {},\n}\n'
  )
  return entries
}

/** Stateful native boundary. No dependency on App, components or any Store. */
export class WebTestBackend {
  readonly fs: WebTestFileSystem
  readonly terminals = new Map<string, Terminal>()
  readonly calls: string[] = []
  readonly failures = new Map<string, string[]>()
  readonly latency = new Map<string, number>()
  readonly dialogs: Array<string | string[] | null> = []
  private roots: string[] = []
  private trusted: string[] = []
  private authorized: string[] = []
  private watches: string[] = []
  private suppressed = new Map<string, number>()
  private connections = new Map<string, Connection>()
  private workspaces = new Map<string, { trusted: boolean; phase: SshServerPhase }>()
  private searchId = 0

  constructor(
    entries: TestEntries,
    persist: () => void,
    readonly db: WebTestDatabase,
    readonly emit: TestEventEmitter
  ) {
    this.fs = new WebTestFileSystem(entries, persist, change => {
      if ((this.suppressed.get(change.path) ?? 0) > Date.now()) return
      if (
        change.path.startsWith('ssh://') ||
        this.watches.some(root => pathWithin(change.path, root))
      ) {
        this.emit('fs-change', change)
      }
    })
  }

  failNext(command: string, message = 'Injected test failure') {
    this.failures.set(command, [...(this.failures.get(command) ?? []), message])
  }

  private ensurePath(path: string, write = false) {
    path = normalizeTestPath(path)
    const grants = write ? this.trusted : this.roots
    if ([...grants, ...this.authorized, '/app'].some(root => pathWithin(path, root))) return
    throw new Error(write ? '当前为受限模式，禁止写入或运行' : '路径不在已注册项目内')
  }

  private connectionId(root: string) {
    return root.match(/^ssh:\/\/([^/]+)/)?.[1] ?? ''
  }

  serverState(rootUri: string): SshServerState {
    const workspace = this.workspaces.get(rootUri)
    const connection = this.connections.get(this.connectionId(rootUri))
    const direct = connection?.mode === 'ssh'
    return {
      connectionId: this.connectionId(rootUri),
      rootUri,
      phase: connection?.connected ? (workspace?.phase ?? 'probing') : 'disconnected',
      mode: direct ? 'direct' : 'server',
      connectionMode: direct ? 'ssh' : 'server',
      version: direct ? null : '0.1.13',
      transport: direct ? 'direct' : 'daemon',
      reason: connection?.connected ? null : 'Web test disconnect',
    }
  }

  disconnect(connectionId = 'web-test') {
    const connection = this.connections.get(connectionId)
    if (connection) connection.connected = false
    for (const root of this.workspaces.keys()) {
      if (this.connectionId(root) === connectionId)
        this.emit('ssh-server-state', this.serverState(root))
    }
    for (const [id, terminal] of this.terminals) {
      if (this.connectionId(terminal.cwd) !== connectionId) continue
      terminal.connected = false
      this.emit('terminal-connection', {
        id,
        state: 'reconnecting',
        reason: 'Web test disconnect',
        attempt: 1,
      })
    }
  }

  reconnect(connectionId = 'web-test') {
    const connection = this.connections.get(connectionId)
    if (!connection) throw new Error('连接尚未建立')
    connection.connected = true
    for (const root of this.workspaces.keys()) {
      if (this.connectionId(root) === connectionId)
        this.emit('ssh-server-state', this.serverState(root))
    }
    for (const [id, terminal] of this.terminals) {
      if (this.connectionId(terminal.cwd) !== connectionId) continue
      terminal.connected = true
      this.emit('terminal-connection', { id, state: 'attached', restore: 'replay' })
    }
  }

  output(id: string, text: string) {
    if (!this.terminals.has(id)) throw new Error('终端不存在')
    this.emit('terminal-data', {
      id,
      data: btoa(
        Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')
      ),
    })
  }

  exit(id: string, exitCode = 0) {
    if (!this.terminals.delete(id)) throw new Error('终端不存在')
    this.emit('terminal-exit', { id, exit_code: exitCode })
  }

  private terminalInput(id: string, data: string) {
    const terminal = this.terminals.get(id)
    if (!terminal || !terminal.connected) throw new Error('终端连接不可用')
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const command = terminal.input.trim()
        terminal.input = ''
        this.output(id, '\r\n')
        if (command === 'exit') {
          this.exit(id)
          return
        }
        if (command === 'pwd') this.output(id, `${terminal.cwd}\r\n`)
        else if (command.startsWith('echo ')) this.output(id, `${command.slice(5)}\r\n`)
        else if (command) this.output(id, `模拟终端不执行系统命令：${command}\r\n`)
        this.output(id, '$ ')
      } else if (char === '\u0003') {
        terminal.input = ''
        this.output(id, '^C\r\n$ ')
      } else if (char === '\u007f') {
        terminal.input = terminal.input.slice(0, -1)
        this.output(id, '\b \b')
      } else {
        terminal.input += char
        this.output(id, char)
      }
    }
  }

  async invoke(command: string, args: Args = {}): Promise<unknown> {
    this.calls.push(command)
    if (this.calls.length > 500) this.calls.shift()
    const failure = this.failures.get(command)?.shift()
    const delay = this.latency.get(command) ?? 0
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    if (failure) throw new Error(failure)
    const path = typeof args.path === 'string' ? args.path : ''
    const id = String(args.id ?? '')
    if (command.startsWith('plugin:sql|')) {
      if (args.db !== TEST_DB) throw new Error('Web test only opens its isolated database')
      if (command === 'plugin:sql|load') return TEST_DB
      if (command === 'plugin:sql|select')
        return this.db.select(String(args.query), args.values as SqlValue[])
      if (command === 'plugin:sql|execute')
        return this.db.execute(String(args.query), args.values as SqlValue[])
    }
    // SSH file commands retain resource URIs and check the simulated transport.
    if (
      command.startsWith('ssh_') &&
      [
        'validate_directory',
        'scan_directory',
        'file_stat',
        'file_mtime',
        'file_ctime',
        'read_file',
        'detect_file_encoding',
        'write_file',
        'create_file',
        'create_directory',
        'rename_path',
        'delete_path',
        'check_symlink_write',
        'list_file_extensions',
        'search_file_contents',
        'search_files',
      ].includes(command.slice(4))
    ) {
      const resource = String(args.path ?? args.parent ?? args.root ?? '')
      if (!this.connections.get(this.connectionId(resource))?.connected)
        throw new Error('SSH 连接已断开')
      return this.dispatch(command.slice(4), args)
    }
    switch (command) {
      case 'db_url':
        return TEST_DB
      case 'default_settings_path':
        return TEST_SETTINGS
      case 'sync_project_roots':
        this.roots = (args.roots as string[]).map(normalizeTestPath)
        return
      case 'sync_trusted_roots':
        this.trusted = (args.roots as string[]).filter(root => this.roots.includes(root))
        return
      case 'authorize_paths':
        this.authorized.push(...(args.paths as string[]).map(normalizeTestPath))
        return args.paths
      case 'sync_file_watches':
        this.watches = [...(args.roots as string[]), ...(args.files as string[])]
        return
      case 'suppress_fs_watch':
        this.suppressed.set(path, Date.now() + 1000)
        return
      case 'is_fs_watch_suppressed':
        return (this.suppressed.get(path) ?? 0) > Date.now()
      case 'ssh_set_server_auto_download':
      case 'ssh_set_server_offline_dir':
        return
      case 'plugin:path|resolve_directory':
        return '/tmp/'
      case 'plugin:dialog|open': {
        if (this.dialogs.length) return this.dialogs.shift()
        const options = args.options as { directory?: boolean; multiple?: boolean }
        const selected = options?.directory ? TEST_ROOT : `${TEST_ROOT}/README.md`
        return options?.multiple ? [selected] : selected
      }
      case 'plugin:dialog|save':
        return this.dialogs.length ? this.dialogs.shift() : `${TEST_ROOT}/saved.txt`
      case 'resolve_run_environment':
      case 'ssh_run_environment':
        this.ensurePath(path, true)
        return { os: 'linux', kind: command === 'ssh_run_environment' ? 'ssh' : 'local' }
      case 'create_terminal':
      case 'ssh_create_terminal':
      case 'spawn_script':
      case 'ssh_spawn_script': {
        const cwd = String(args.cwd)
        this.ensurePath(cwd, true)
        const remote = cwd.startsWith('ssh://')
        if (remote && !this.connections.get(this.connectionId(cwd))?.connected)
          throw new Error('SSH 连接已断开')
        this.terminals.set(id, {
          cwd,
          input: '',
          connected: true,
          script: command.endsWith('spawn_script'),
        })
        return {
          resolvedShell: 'bash',
          fallbackFrom: null,
          persistent: remote,
          ptyId: remote ? id : undefined,
          connectionId: remote ? this.connectionId(cwd) : undefined,
        }
      }
      case 'terminal_session_open':
        return this.terminals.has(id)
      case 'terminal_has_child_processes':
        return this.terminals.get(id)?.script ?? false
      case 'write_terminal':
      case 'ssh_write_terminal':
        this.terminalInput(id, String(args.data))
        return
      case 'kill_terminal':
      case 'ssh_kill_terminal':
        this.terminals.delete(id)
        return
      case 'resize_terminal':
      case 'ssh_resize_terminal':
      case 'set_terminal_output_paused':
        return
      case 'ssh_list_detached_terminals':
        return []
      case 'ssh_probe_host':
        return { fingerprint: TEST_FINGERPRINT }
      case 'ssh_open_session': {
        const config = args.config as { id: string; mode?: string; hostKeyFingerprint?: string }
        if (config.id !== 'web-test') throw new Error('Only the web-test SSH fixture is supported')
        if (config.hostKeyFingerprint !== TEST_FINGERPRINT) throw new Error('SSH 主机指纹不匹配')
        this.connections.set(config.id, { mode: config.mode ?? 'server', connected: true })
        return { fingerprint: TEST_FINGERPRINT, homePath: '/home/demo' }
      }
      case 'ssh_browse_directory': {
        const root = `ssh://${String(args.connectionId)}${path}`
        return {
          path,
          entries: this.fs
            .list(root)
            .map(entry => ({ ...entry, path: entry.path.replace(/^ssh:\/\/[^/]+/, '') })),
        }
      }
      case 'ssh_connect': {
        const config = args.config as { id: string; mode?: string; hostKeyFingerprint?: string }
        await this.invoke('ssh_open_session', { config })
        const root = String(args.rootUri)
        const trusted = args.trusted === true
        this.workspaces.set(root, {
          trusted,
          phase: config.mode === 'ssh' ? 'readyDirect' : 'readyServer',
        })
        if (!this.roots.includes(root)) this.roots.push(root)
        if (trusted && !this.trusted.includes(root)) this.trusted.push(root)
        return
      }
      case 'ssh_set_workspace_trust': {
        const root = String(args.rootUri)
        const workspace = this.workspaces.get(root)
        if (workspace) workspace.trusted = args.trusted === true
        this.trusted = this.trusted.filter(value => value !== root)
        if (args.trusted === true) this.trusted.push(root)
        return
      }
      case 'ssh_prepare_workspace':
        return
      case 'ssh_workspace_status':
        return (
          this.workspaces.has(String(args.rootUri)) &&
          !!this.connections.get(this.connectionId(String(args.rootUri)))?.connected
        )
      case 'ssh_connection_status':
        return this.connections.get(String(args.connectionId))?.connected ?? false
      case 'ssh_disconnect':
        this.disconnect(String(args.connectionId))
        return
      case 'ssh_server_info':
        return this.serverState(String(args.rootUri))
      case 'ssh_server_restart':
        this.reconnect(this.connectionId(String(args.rootUri)))
        return this.serverState(String(args.rootUri))
      case 'ssh_server_logs':
        return { text: 'Web test simulated remote service\n' }
      case 'ssh_server_states':
        return [...this.workspaces.keys()].map(root => this.serverState(root))
      case 'ssh_workspace_roots':
        return [...this.workspaces].map(([rootUri, workspace]) => ({
          rootUri,
          trusted: workspace.trusted,
        }))
      default:
        return this.dispatch(command, args)
    }
  }

  private dispatch(command: string, args: Args): unknown {
    const path = typeof args.path === 'string' ? normalizeTestPath(args.path) : ''
    switch (command) {
      case 'validate_directory':
        if (!this.fs.get(path).directory) throw new Error('目录不可用')
        return
      case 'scan_directory': {
        this.ensurePath(path)
        if (args.excludeGitIgnore === true)
          throw new Error('Web test does not simulate .gitignore rules')
        const root = String(args.workspaceRoot ?? path)
        return this.fs
          .list(path)
          .filter(
            entry =>
              !isPathExcluded(
                entry.path.slice(root.length + 1),
                (args.excludePatterns as string[]) ?? []
              )
          )
      }
      case 'read_file':
        this.ensurePath(path)
        return this.fs.read(path)
      case 'file_stat': {
        this.ensurePath(path)
        const entry = this.fs.get(path)
        return { size: new TextEncoder().encode(entry.content).length, is_dir: entry.directory }
      }
      case 'file_mtime':
      case 'file_ctime':
        this.ensurePath(path)
        return this.fs.get(path).mtime
      case 'detect_file_encoding':
        this.ensurePath(path)
        return 'utf8'
      case 'check_symlink_write':
        this.ensurePath(path, true)
        return { needs_confirm: false, resolved_path: null }
      case 'write_file': {
        this.ensurePath(path, true)
        if (args.encoding && !['utf8', 'auto'].includes(String(args.encoding)))
          throw new Error('Web test supports UTF-8 text only')
        // Native write_file creates missing parent directories (settings/run config).
        const missing: string[] = []
        for (let parent = testParent(path); !this.fs.entries[parent]; parent = testParent(parent))
          missing.unshift(parent)
        missing.forEach(parent => this.fs.write(parent, '', true, true))
        this.fs.write(path, String(args.content))
        return
      }
      case 'create_file':
      case 'create_directory': {
        const name = String(args.name)
        if (!name || /[/\\]/.test(name) || name === '.' || name === '..')
          throw new Error('无效名称')
        const target = `${String(args.parent).replace(/\/$/, '')}/${name}`
        this.ensurePath(target, true)
        this.fs.write(target, '', true, command === 'create_directory')
        return target
      }
      case 'delete_path':
        this.ensurePath(path, true)
        this.fs.remove(path)
        return
      case 'rename_path':
      case 'move_path':
      case 'copy_path_into': {
        const source = path || String(args.source)
        const target =
          command === 'rename_path'
            ? `${testParent(source)}/${String(args.newName)}`
            : `${String(args.destDir).replace(/\/$/, '')}/${String(args.destName ?? source.slice(source.lastIndexOf('/') + 1))}`
        this.ensurePath(source, command !== 'copy_path_into')
        this.ensurePath(target, true)
        return this.fs.relocate(source, target, command === 'copy_path_into')
      }
      case 'directory_delete_stats':
      case 'directory_entry_counts': {
        this.ensurePath(path)
        const children = Object.entries(this.fs.entries)
          .filter(([key]) => key !== path && pathWithin(key, path))
          .map(([, value]) => value)
        return {
          fileCount: children.filter(entry => !entry.directory).length,
          folderCount: children.filter(entry => entry.directory).length,
          totalSize: children.reduce(
            (n, entry) => n + new TextEncoder().encode(entry.content).length,
            0
          ),
        }
      }
      case 'get_git_head':
      case 'get_git_workdir_status':
        return null
      case 'git_status':
        return { is_repository: false, branch: null, changes: [] }
      case 'start_content_search':
        return ++this.searchId
      case 'cancel_content_search':
        return ++this.searchId
      case 'list_file_extensions': {
        const roots = args.roots as string[]
        roots.forEach(root => this.ensurePath(root))
        return [
          ...new Set(
            Object.keys(this.fs.entries)
              .filter(key => roots.some(root => pathWithin(key, root)))
              .map(key => key.split('/').pop()!.split('.').slice(1).pop())
              .filter(Boolean)
          ),
        ]
      }
      case 'search_files': {
        const root = String(args.root)
        this.ensurePath(root)
        return Object.keys(this.fs.entries)
          .filter(
            key =>
              key !== root &&
              pathWithin(key, root) &&
              !isPathExcluded(
                key.slice(root.length + 1),
                (args.excludePatterns as string[]) ?? []
              ) &&
              key.toLowerCase().includes(String(args.query).toLowerCase())
          )
          .slice(0, Number(args.limit ?? 500))
          .map(key => ({
            name: key.slice(key.lastIndexOf('/') + 1),
            path: key,
            relative: key.slice(root.length + 1),
            is_dir: this.fs.entries[key].directory,
          }))
      }
      case 'search_file_contents': {
        const root = String(args.root)
        this.ensurePath(root)
        const ignoreCase = args.ignoreCase === true
        const query = ignoreCase ? String(args.query).toLowerCase() : String(args.query)
        if (!query) throw new Error('搜索词不能为空')
        const limit = Number(args.maxMatches ?? 500)
        const files = []
        let count = 0
        let scanned = 0
        let truncated = false
        for (const [key, entry] of Object.entries(this.fs.entries)) {
          if (
            entry.directory ||
            !pathWithin(key, root) ||
            isPathExcluded(key.slice(root.length + 1), (args.excludePatterns as string[]) ?? [])
          )
            continue
          if (
            (args.extensions as string[] | null)?.length &&
            !(args.extensions as string[]).includes(key.split('.').pop()!)
          )
            continue
          if (scanned >= Number(args.maxFilesScanned ?? 8000) || count >= limit) {
            truncated = true
            break
          }
          scanned++
          const matches = []
          for (const [index, text] of entry.content.split('\n').entries()) {
            const haystack = ignoreCase ? text.toLowerCase() : text
            let start = haystack.indexOf(query)
            while (
              start >= 0 &&
              count < limit &&
              matches.length < Number(args.maxMatchesPerFile ?? 20)
            ) {
              matches.push({
                line: index + 1,
                text,
                match_start: start,
                match_end: start + query.length,
              })
              count++
              start = haystack.indexOf(query, start + query.length)
            }
          }
          if (matches.length)
            files.push({
              name: key.slice(key.lastIndexOf('/') + 1),
              path: key,
              relative: key.slice(root.length + 1),
              matches,
            })
        }
        return {
          files,
          match_count: count,
          files_scanned: scanned,
          truncated,
          cancelled: args.searchId != null && args.searchId !== this.searchId,
        }
      }
      default:
        throw new Error(`Web 测试环境未实现接口：${command}`)
    }
  }
}
