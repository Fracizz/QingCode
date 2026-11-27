/**
 * 本机端到端验收：ensure → 命名管道握手 → ping → fs.home。
 *
 * 仓库根执行（tsx 未安装，用 esbuild 打成本机可运行脚本）：
 *   pnpm build:server
 *   pnpm exec esbuild apps/desktop/src/backend/dev/smoke-local.ts --bundle --platform=node --format=esm --external:ssh2 --external:cpu-features --outfile=apps/desktop/.dev/smoke-local.mjs
 *   node apps/desktop/.dev/smoke-local.mjs
 * 也可用 vitest 跑：QN_SMOKE_LOCAL=1 pnpm exec vitest run apps/desktop/src/backend/dev/smoke-local.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_TARGET } from '../../shared/backendApi'
import { backendConfig } from '../config'
import { TargetManager } from '../targets'

export interface LocalSmokeOptions {
  userData?: string
  resourcesPath?: string
  electronPath?: string
  emit?: (name: string, payload: unknown) => void
}

export interface LocalSmokeResult {
  ping: unknown
  home: unknown
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

function defaultPaths(): { resourcesPath: string; electronPath: string } {
  const root = process.cwd()
  return {
    resourcesPath: process.env['QN_RESOURCES_PATH'] ?? join(root, 'apps', 'desktop', 'resources'),
    electronPath: process.env['QN_ELECTRON_PATH'] ?? join(
      root,
      'apps',
      'desktop',
      'node_modules',
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron'
    ),
  }
}

export async function runLocalSmoke(options: LocalSmokeOptions = {}): Promise<LocalSmokeResult> {
  const defaults = defaultPaths()
  const temporary = options.userData || backendConfig.userData
    ? null
    : await mkdtemp(join(tmpdir(), 'qn-smoke-local-'))
  const userData = options.userData ?? (backendConfig.userData || temporary)
  const manager = new TargetManager({
    userData: userData ?? '',
    resourcesPath: options.resourcesPath ?? defaults.resourcesPath,
    electronPath: options.electronPath ?? defaults.electronPath,
    appVersion: backendConfig.appVersion,
    emit: (name, payload) => {
      options.emit?.(name, payload)
      if (name === 'target.state') {
        const state = payload as { state: string; detail?: string }
        console.log(`[target.state] ${state.state}${state.detail ? ` ${state.detail}` : ''}`)
      }
    },
  })
  try {
    await manager.connect(LOCAL_TARGET, {})
    await manager.waitUntilReady('local', 30_000)
    const ping = await manager.request('local', 'ping')
    const home = await manager.request('local', 'fs.home')
    if (!isRecord(home) || typeof home.path !== 'string' || home.path === '') {
      throw new Error('fs.home 返回结果无效')
    }
    return { ping, home }
  } finally {
    manager.shutdown()
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}

// 打包后由入口文件名判断，避免被其他脚本 import 时误跑 CLI。
function isMain(): boolean {
  const entry = process.argv[1] ?? ''
  return /(?:^|[\\/])smoke-local\.(?:mjs|js|cjs|ts)$/.test(entry)
}

if (isMain()) {
  runLocalSmoke()
    .then((result) => {
      console.log('本机 smoke 通过：')
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((err: unknown) => {
      console.error(`本机 smoke 失败：${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    })
}
