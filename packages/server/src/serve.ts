import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeDirectCode } from '@qn/protocol'
import type { CliArgs } from './args'
import { IpcClient } from './client'
import { candidateHosts, loadOrCreateCert, parseListen, type DirectStatus } from './direct/listener'
import { addGrant, directFiles, readConfig, removeConfig, removeGrant, writeConfig } from './direct/store'
import { ensure } from './ensure'
import { resolvePaths } from './paths'

// 直连管理命令：只改 <stateDir>/direct 下的配置/授权文件，再让常驻 daemon 重读。
// 典型用法是桌面端经 SSH 执行一次 `direct enable` + `direct grant`，之后 SSH 可断开，直连由 daemon 常驻提供。

export { candidateHosts, parseListen } from './direct/listener'

const RELOAD_TIMEOUT_MS = 15_000

async function reloadDaemon(stateDir: string | undefined): Promise<DirectStatus> {
  const info = await ensure({ ...(stateDir !== undefined ? { stateDir } : {}) })
  const paths = resolvePaths(stateDir)
  const client = await IpcClient.connect(paths, info.token)
  try {
    return (await client.request('direct.reload', undefined, RELOAD_TIMEOUT_MS)) as DirectStatus
  } finally {
    client.close()
  }
}

export interface GrantOutput {
  grantId: string
  code: string
  fingerprint: string
  hosts: string[]
  port: number
}

/** 新建授权并生成连接码；连接码含明文 token，只写 stdout，不进日志。 */
async function grant(args: CliArgs): Promise<GrantOutput> {
  const paths = resolvePaths(args.stateDir)
  const files = directFiles(paths.stateDir)
  const config = readConfig(files)
  if (!config) throw new Error('直连未开启，请先执行 direct enable --listen <端口>')
  const listen = parseListen(config.listen)
  const cert = await loadOrCreateCert(paths.stateDir)
  const { grant: created, token } = addGrant(files, args.name ?? 'client')
  const hosts = args.hosts ?? candidateHosts(listen.host)
  const code = encodeDirectCode({
    v: 1,
    hosts,
    port: listen.port,
    token,
    fingerprint: cert.fingerprint,
    name: os.hostname(),
  })
  return { grantId: created.id, code, fingerprint: cert.fingerprint, hosts, port: listen.port }
}

export async function runDirect(args: CliArgs): Promise<unknown> {
  const paths = resolvePaths(args.stateDir)
  const files = directFiles(paths.stateDir)
  switch (args.action) {
    case 'enable': {
      const listen = args.listen ?? ''
      parseListen(listen)
      writeConfig(files, { listen, allowPublic: args.allowPublic === true })
      const status = await reloadDaemon(args.stateDir)
      // i18n-ignore: 按实际取值在词典登记整句
      if (!status.listening) throw new Error(`直连监听失败: ${status.error ?? '未知原因'}`)
      return status
    }
    case 'disable':
      removeConfig(files)
      return reloadDaemon(args.stateDir)
    case 'grant': {
      const output = await grant(args)
      // 让 daemon 立即载入新授权；daemon 未运行时 reload 会顺带拉起。
      await reloadDaemon(args.stateDir)
      return output
    }
    case 'revoke':
      if (!removeGrant(files, args.id ?? '')) throw new Error(`授权不存在: ${args.id ?? ''}`)
      return reloadDaemon(args.stateDir)
    case 'status':
      return reloadDaemon(args.stateDir)
    default:
      throw new Error('direct 需要子命令')
  }
}

/** 兼容旧用法：`serve --listen` = enable + grant，打印连接码后退出（监听由 daemon 常驻）。 */
export async function runServe(args: CliArgs): Promise<unknown> {
  await runDirect({ ...args, command: 'direct', action: 'enable' })
  const output = await grant({ ...args, name: args.name ?? 'serve' })
  await reloadDaemon(args.stateDir)
  const paths = resolvePaths(args.stateDir)
  const codeFile = path.join(paths.stateDir, 'direct-code.txt')
  fs.writeFileSync(codeFile, `${output.code}\n`, { encoding: 'utf8', mode: 0o600 })
  return { listen: args.listen, ...output, codeFile }
}
