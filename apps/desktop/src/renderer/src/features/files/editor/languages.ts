// 语言解析：按文件名匹配 language-data 的描述并懒加载对应语言包。
// language-data 只静态引入描述列表；各语言包由其内部 dynamic import 拆成独立 chunk。

import { LanguageDescription } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { basename } from '../fileLinks'

/** Windows / POSIX 路径统一取最后一段；隐藏文件（.gitignore）也保留。 */
export function matchFileName(path: string): string {
  return basename(path) || ''
}

/** 纯函数：先按 filename 正则，再按扩展名；大小写不敏感，找不到返回 null（纯文本）。 */
export function matchLanguageDescription(
  descriptions: readonly LanguageDescription[],
  path: string,
): LanguageDescription | null {
  const name = matchFileName(path)
  if (!name) return null
  const direct = LanguageDescription.matchFilename(descriptions, name)
  if (direct) return direct
  const lower = name.toLowerCase()
  if (lower !== name) return LanguageDescription.matchFilename(descriptions, lower)
  return null
}

export type LanguageLoader = () => Promise<readonly LanguageDescription[]>

/** 动态导入把描述表和语言包一起拆出主包，避免首屏加载全部语法。 */
const loadDescriptions: LanguageLoader = async () => (await import('@codemirror/language-data')).languages

/** 加载失败（缺包、网络异常）时退化为纯文本，不阻断编辑。 */
export async function loadLanguageForPath(
  path: string,
  loader: LanguageLoader = loadDescriptions,
): Promise<Extension> {
  try {
    const descriptions = await loader()
    const description = matchLanguageDescription(descriptions, path)
    if (!description) return []
    return await description.load()
  } catch {
    return []
  }
}
