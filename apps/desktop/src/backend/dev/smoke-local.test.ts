import { it } from 'vitest'
import { runLocalSmoke } from './smoke-local'

// 集成脚本默认跳过，避免普通单测依赖 Electron 二进制与已构建的 server 包。
const check = process.env['QN_SMOKE_LOCAL'] === '1' ? it : it.skip

check('本机 target：ensure → ping → fs.home', async () => {
  const result = await runLocalSmoke()
  if (typeof (result.home as { path?: unknown }).path !== 'string') {
    throw new Error('fs.home 未返回路径')
  }
}, 60_000)
