import { PROTOCOL_VERSION } from '@qn/protocol'
import { QnUsageError, runQn } from './agentctl/cli'
import { CliError, parseArgs } from './args'
import { runConnect } from './connect'
import { runDaemon } from './daemon'
import { ensure } from './ensure'
import { runDirect, runServe } from './serve'
import { VERSION } from './version'

const USAGE = [
  '用法: qn-server.cjs version',
  '  | ensure [--state-dir D] [--replace]',
  '  | daemon [--state-dir D]',
  '  | connect --stdio [--state-dir D]',
  '  | direct enable --listen [host:]port [--allow-public] | direct disable',
  '  | direct grant [--name N] [--host H]... | direct revoke --id ID | direct status',
  '  | serve --listen [host:]port [--allow-public] [--name N] [--host H]...（= enable + grant）',
].join('\n')

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** qn 子命令有自己的参数与输出格式，不走 server 的 parseArgs。 */
async function mainQn(argv: string[]): Promise<void> {
  try {
    process.exitCode = await runQn(argv, {
      env: process.env,
      cwd: process.cwd(),
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hint = err instanceof QnUsageError ? '\n运行 qn guide 查看用法' : ''
    process.stderr.write(`qn: ${message}${hint}\n`)
    process.exitCode = err instanceof QnUsageError ? 2 : 1
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'qn') return mainQn(process.argv.slice(3))
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'version':
      print({ version: VERSION, protocol: PROTOCOL_VERSION })
      return
    case 'ensure':
      print(await ensure({ stateDir: args.stateDir, replace: args.replace }))
      return
    case 'daemon':
      await runDaemon({ stateDir: args.stateDir, version: VERSION })
      return
    case 'connect':
      await runConnect({ stateDir: args.stateDir })
      return
    case 'direct':
      print(await runDirect(args))
      return
    case 'serve':
      print(await runServe(args))
      return
  }
}

main().catch((err: unknown) => {
  const message = err instanceof CliError
    ? `${err.message}\n${USAGE}`
    : err instanceof Error
      ? err.message
      : String(err)
  process.stderr.write(`qn-server: ${message}\n`)
  process.exitCode = 1
})
