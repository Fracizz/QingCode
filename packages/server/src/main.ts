import { PROTOCOL_VERSION } from '@qn/protocol'
import { CliError, parseArgs } from './args'
import { runConnect } from './connect'
import { runDaemon } from './daemon'
import { ensure } from './ensure'
import { runDirect, runServe } from './serve'
import { VERSION } from './version'
import { runClaudeHistoryWorker } from './claude/sessionReader'

const USAGE = [
  '用法: qn-server.cjs version',
  '  | ensure [--state-dir D] [--replace | --force-replace]',
  '  | daemon [--state-dir D]',
  '  | connect --stdio [--state-dir D]',
  '  | direct enable --listen [host:]port [--allow-public] | direct disable',
  '  | direct grant [--name N] [--host H]... | direct revoke --id ID | direct status',
  '  | serve --listen [host:]port [--allow-public] [--name N] [--host H]...（= enable + grant）',
].join('\n')

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  if (await runClaudeHistoryWorker()) return
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'version':
      print({ version: VERSION, protocol: PROTOCOL_VERSION })
      return
    case 'ensure':
      print(await ensure({ stateDir: args.stateDir, replace: args.replace, forceReplace: args.forceReplace }))
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
