import { describe, expect, it } from 'vitest'
import { isPiDialogRequest, parsePiDialog, piDialogQuestions, piDialogResponse } from './extensionUi'

const answer = (value: string) => ({ id: 'r', result: { answers: { q0: { answers: [value] } } } })
const request = (method: string, extra: Record<string, unknown> = {}) =>
  parsePiDialog({ type: 'extension_ui_request', id: 'ui-1', method, title: '标题', ...extra })!

describe('pi 扩展对话框', () => {
  it('只把四种对话框当作提问，通知类记录忽略', () => {
    expect(isPiDialogRequest({ type: 'extension_ui_request', id: 'a', method: 'notify' })).toBe(false)
    expect(parsePiDialog({ type: 'extension_ui_request', method: 'confirm' })).toBeNull()
    expect(request('confirm', { timeout: 5000 }).timeoutMs).toBe(5000)
  })

  it('选项、自由输入与多行编辑映射为对应问题', () => {
    expect(piDialogQuestions(request('select', { options: ['甲', '乙'] }))[0]).toMatchObject({
      isOther: false, options: [{ label: '甲' }, { label: '乙' }],
    })
    expect(piDialogQuestions(request('confirm', { message: '说明' }))[0]).toMatchObject({
      question: '标题\n说明', localizedOptions: true, isOther: false,
    })
    expect(piDialogQuestions(request('editor', { prefill: '原文' }))[0]).toMatchObject({
      isOther: true, multiline: true, prefill: '原文',
    })
  })

  it('按用户回答组装响应，跳过或越界一律取消', () => {
    const confirm = request('confirm')
    expect(piDialogResponse(confirm, answer('是'))).toMatchObject({ id: 'ui-1', confirmed: true })
    expect(piDialogResponse(confirm, answer('否'))).toMatchObject({ confirmed: false })
    expect(piDialogResponse(confirm, { id: 'r', result: { answers: {} } })).toMatchObject({ cancelled: true })
    expect(piDialogResponse(confirm, { id: 'r', error: { code: -1 } })).toMatchObject({ cancelled: true })
    const select = request('select', { options: ['甲'] })
    expect(piDialogResponse(select, answer('甲'))).toMatchObject({ value: '甲' })
    expect(piDialogResponse(select, answer('丙'))).toMatchObject({ cancelled: true })
    expect(piDialogResponse(request('input'), answer('内容'))).toMatchObject({ value: '内容' })
  })
})
