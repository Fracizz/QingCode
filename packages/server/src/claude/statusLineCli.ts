import { IpcClient } from '../client'
import { resolvePaths } from '../paths'
import { statusLineWindows, statusLineProfile } from './statusLine'
import { asRecord } from './v2'

const MAX_INPUT_BYTES = 256 * 1024
const IPC_TIMEOUT_MS = 500

/** 可串在用户已有的 statusLine 脚本后面，仅连接已经运行的 daemon。 */
export async function publishClaudeStatusLine(stateDir?: string): Promise<void> {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += data.length
    if (bytes > MAX_INPUT_BYTES) return
    chunks.push(data)
  }

  try {
    const raw = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const { primary, secondary } = statusLineWindows(raw?.rate_limits)
    if (!primary && !secondary) return
    const client = await IpcClient.connect(resolvePaths(stateDir), undefined, IPC_TIMEOUT_MS)
    try {
      await client.request('claude.statusline.publish', {
        directory: statusLineProfile(process.env.CLAUDE_CONFIG_DIR),
        windows: {
          five_hour: primary && { used_percentage: primary.usedPercent, resets_at: primary.resetsAt },
          seven_day: secondary && { used_percentage: secondary.usedPercent, resets_at: secondary.resetsAt },
        },
      }, IPC_TIMEOUT_MS)
    } finally {
      client.close()
    }
  } catch {
    // daemon 未运行或状态读数缺失时，原有 CLI 状态栏仍应照常显示。
  }
}
