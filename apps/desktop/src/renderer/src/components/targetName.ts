import { translateMessage } from '@qn/codex-client'
import type { Target } from '../../../shared/backendApi'

/** 本机目标的名称由 backend 固定给出，展示时随界面语言翻译；其他目标名是用户内容，原样显示。 */
export function targetDisplayName(target: Target): string {
  return target.kind === 'local' ? translateMessage(target.name) : target.name
}
