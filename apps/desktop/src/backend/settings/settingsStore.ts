import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings } from '../../shared/backendApi'
import { defaultAppSettings, sanitizeAppSettings } from './appSettings'

const SETTINGS_FILE = 'settings.json'

/** 文件缺失、JSON 损坏或形状异常时回退默认值，不让设置挡住启动。 */
export async function readAppSettings(userData: string): Promise<AppSettings> {
  try {
    const text = await readFile(join(userData, SETTINGS_FILE), 'utf8')
    return sanitizeAppSettings(JSON.parse(text) as unknown)
  } catch {
    return defaultAppSettings()
  }
}

/** 先写同目录 .tmp 再 rename，避免写到一半留下损坏文件。 */
export async function writeAppSettings(userData: string, settings: AppSettings): Promise<void> {
  const normalized = sanitizeAppSettings(settings)
  const file = join(userData, SETTINGS_FILE)
  const tmp = `${file}.tmp`
  await mkdir(userData, { recursive: true })
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(tmp, file)
}
