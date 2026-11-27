/**
 * pi 扩展对话框（官方 docs/rpc-extension-ui.md）↔ v2 item/tool/requestUserInput 的纯函数转换。
 * 只负责把问题交给用户、把用户的回答带回去；跳过或回答无效一律按 cancelled 返回，不代答。
 */
import { asRecord, scalarText, type Json } from '../claude/v2'

export type PiDialogMethod = 'select' | 'confirm' | 'input' | 'editor'

export interface PiDialog {
  id: string
  method: PiDialogMethod
  title: string
  message: string
  options: string[]
  prefill: string
  /** pi 到时会自行按默认值收场；客户端据此撤掉问题卡片。 */
  timeoutMs: number | null
}

const CONFIRM_YES = '是'
const CONFIRM_NO = '否'
const QUESTION_ID = 'q0'

export function isPiDialogRequest(record: unknown): boolean {
  const data = asRecord(record)
  return data?.type === 'extension_ui_request' && typeof data.id === 'string' &&
    (data.method === 'select' || data.method === 'confirm' || data.method === 'input' || data.method === 'editor')
}

export function parsePiDialog(record: unknown): PiDialog | null {
  if (!isPiDialogRequest(record)) return null
  const data = record as Json
  const options = Array.isArray(data.options)
    ? [...new Set(data.options.filter((option): option is string => typeof option === 'string' && option !== ''))]
    : []
  const timeout = data.timeout
  return {
    id: data.id as string,
    method: data.method as PiDialogMethod,
    title: scalarText(data.title),
    message: scalarText(data.message) || scalarText(data.placeholder),
    options,
    prefill: scalarText(data.prefill),
    timeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : null,
  }
}

export function piDialogQuestions(dialog: PiDialog): Json[] {
  const confirm = dialog.method === 'confirm'
  const labels = confirm ? [CONFIRM_YES, CONFIRM_NO] : dialog.method === 'select' ? dialog.options : []
  return [{
    id: QUESTION_ID,
    header: '',
    question: [dialog.title, dialog.message].filter(Boolean).join('\n') || 'pi',
    isOther: labels.length === 0,
    isSecret: false,
    options: labels.map((label) => ({ label, description: '' })),
    // 固定选项由界面按当前语言显示，回传值保持原文。
    ...(confirm ? { localizedOptions: true } : {}),
    ...(dialog.method === 'editor' ? { multiline: true } : {}),
    ...(dialog.prefill ? { prefill: dialog.prefill } : {}),
  }]
}

/** 客户端的 JSON-RPC 响应 → extension_ui_response。 */
export function piDialogResponse(dialog: PiDialog, response: unknown): Json {
  const base = { type: 'extension_ui_response', id: dialog.id }
  const result = asRecord(asRecord(response)?.result)
  const answers = asRecord(asRecord(result?.answers)?.[QUESTION_ID])?.answers
  const value = Array.isArray(answers) ? answers[0] : undefined
  if (typeof value !== 'string') return { ...base, cancelled: true }
  if (dialog.method === 'confirm') {
    return value === CONFIRM_YES || value === CONFIRM_NO
      ? { ...base, confirmed: value === CONFIRM_YES }
      : { ...base, cancelled: true }
  }
  if (dialog.method === 'select' && !dialog.options.includes(value)) return { ...base, cancelled: true }
  return { ...base, value }
}
