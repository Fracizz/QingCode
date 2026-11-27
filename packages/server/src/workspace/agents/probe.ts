import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceError } from '../registry'
import type { WorkspaceHandler } from '../registry'
import {
  buildVersionCommand,
  classifyVersionRun,
  isBareName,
  parseProbeParams,
  probeCandidates,
  type ProbeEnv,
  type ProbeResult,
  type VersionRun,
} from './logic'

const VERSION_TIMEOUT_MS = 3_000
const MAX_OUTPUT_BYTES = 64 * 1024

export interface ProbeDeps {
  exists(file: string): boolean
  run(file: string): VersionRun
  env: ProbeEnv
}

function defaultEnv(): ProbeEnv {
  return {
    platform: process.platform,
    pathValue: process.env['PATH'] ?? '',
    home: os.homedir(),
    delimiter: path.delimiter,
    ...(process.env['LOCALAPPDATA'] ? { localAppData: process.env['LOCALAPPDATA'] } : {}),
  }
}

function runVersion(file: string): VersionRun {
  const spec = buildVersionCommand(file, process.platform, process.env['ComSpec'] ?? 'cmd.exe')
  try {
    const result = spawnSync(spec.command, spec.args, {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      ...(typeof errorCode === 'string' ? { errorCode } : {}),
      timedOut: errorCode === 'ETIMEDOUT',
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      status: null,
      stdout: '',
      stderr: '',
      ...(typeof code === 'string' ? { errorCode: code } : { errorCode: 'UNKNOWN' }),
      timedOut: false,
    }
  }
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    exists: (file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    run: runVersion,
    env: defaultEnv(),
  }
}

/**
 * 依次尝试候选可执行文件，第一个成功返回版本即结束。
 * 只做 `--version` 与文件存在性检查，不启动会话、不读写 Agent 配置、不注入环境变量（合规 §3.2 / §7 / R9）。
 */
export function probeAgent(
  raw: Record<string, unknown>,
  deps: ProbeDeps = defaultProbeDeps(),
): ProbeResult {
  const params = parseProbeParams(raw)
  if (!params) throw new WorkspaceError('params', 'agent.probe 需要有效的 agent 与可选 path')
  let lastError = '未找到可执行文件'
  for (const candidate of probeCandidates(params.agent, params.path, deps.env)) {
    if (!isBareName(candidate) && !deps.exists(candidate)) continue
    const outcome = classifyVersionRun(deps.run(candidate))
    if (outcome.ok) {
      return {
        found: true,
        path: candidate,
        ...(outcome.version ? { version: outcome.version } : {}),
      }
    }
    lastError = outcome.error
  }
  return { found: false, path: params.path ?? '', error: lastError }
}

export const agentProbe: WorkspaceHandler = async (params) => probeAgent(params)
