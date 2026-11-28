import fs from 'node:fs'
import path from 'node:path'
import { asRecord, type Json } from './v2'

/** 文件内容：配置目录（默认目录记为空串）→ 最近一次取到的 model/list 结果。 */
export function parseModelCache(value: unknown): Record<string, Json> {
  const result: Record<string, Json> = {}
  for (const [directory, entry] of Object.entries(asRecord(value) ?? {})) {
    const list = asRecord(entry)
    if (Array.isArray(list?.data) && list.data.length > 0) result[directory] = list
  }
  return result
}

/**
 * 真实模型表只有 Claude 进程启动后才拿得到，而打开历史会话不启动进程。
 * 把上次取到的表记在目标机状态目录，daemon 重启后首次请求前也能显示具体模型名。
 */
export class ModelCache {
  private cache: Record<string, Json> | undefined

  constructor(
    private readonly stateDir: string | undefined,
    private readonly log: (message: string) => void,
  ) {}

  get(directory: string | undefined): Json | null {
    return this.read()[directory ?? ''] ?? null
  }

  set(directory: string | undefined, list: Json): void {
    this.cache = { ...this.read(), [directory ?? '']: list }
    const file = this.file()
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, `${JSON.stringify(this.cache)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      this.log('claude 模型表缓存保存失败') // i18n-ignore: 仅进日志
    }
  }

  private read(): Record<string, Json> {
    if (this.cache) return this.cache
    const file = this.file()
    if (!file) return (this.cache = {})
    try {
      this.cache = parseModelCache(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('claude 模型表缓存读取失败') // i18n-ignore: 仅进日志
      this.cache = {}
    }
    return this.cache
  }

  private file(): string | undefined {
    return this.stateDir ? path.join(this.stateDir, 'model-list', 'claude.json') : undefined
  }
}
