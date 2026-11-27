// 需要按语言单独取值的名称。
import { getLocale, translateMessage } from '@qn/codex-client'

export type PageName = 'sessions' | 'projects' | 'usage' | 'connections'

/** 导航与页面标题：同一原文在别处是单数或动词（Session / Project / Connect），词典一个键只能有一种译法。 */
export function pageName(page: PageName): string {
  const english = getLocale() === 'en'
  // i18n-ignore: 见函数说明
  if (page === 'sessions') return english ? 'Sessions' : '会话'
  // i18n-ignore: 见函数说明
  if (page === 'projects') return english ? 'Projects' : '项目'
  // i18n-ignore: 见函数说明
  if (page === 'usage') return english ? 'Usage' : '用量'
  // i18n-ignore: 见函数说明
  return english ? 'Connections' : '连接'
}

/** 默认电脑名以中文原文保存（电脑端发来的也是中文）；只翻译这个常量，用户起的名字原样显示。 */
export function connectionName(name: string): string {
  // i18n-ignore: 匹配默认名原文
  return name === '未命名电脑' ? translateMessage(name) : name
}
