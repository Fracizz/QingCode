import { it } from 'vitest'
import { parseSmokeArgs, runSshSmoke } from './smoke-ssh'

// 真机验收默认跳过；总管用 QN_SMOKE_SSH="host port user keyPath" 显式启用。
const argsText = process.env['QN_SMOKE_SSH']
const check = argsText ? it : it.skip

check('远端 target：部署 → ping → fs.home → codex.open', async () => {
  const args = parseSmokeArgs(argsText!.trim().split(/\s+/))
  await runSshSmoke(args)
}, 180_000)
