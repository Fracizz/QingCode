// 只能依赖语言核心与词典：main.tsx 首个导入它，保证其他模块求值时语言已确定。
import { initLocale } from '../../../../../packages/codex-client/src/i18n/localeInit'
import mobile from './mobile.en'

initLocale([mobile])
