import type { FontSettings } from '../../lib/fontSettings'

/** 设置页当前作用域：user=全局默认，workspace=当前项目。 */
export type SettingsScope = 'user' | 'workspace'

/** 行级搜索过滤：任一关键词命中当前查询即显示该设置项。 */
export type SettingsMatch = (...texts: string[]) => boolean

/** 更新单个字体设置字段并持久化。 */
export type FontSettingUpdater = <K extends keyof FontSettings>(
  key: K,
  value: FontSettings[K],
) => void
