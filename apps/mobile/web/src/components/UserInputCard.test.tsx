// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ApprovalView } from '@qn/codex-client'
import { UserInputCard } from './UserInputCard'

const question = (id: string) => ({
  id, header: `题头${id}`, question: `问题${id}`, multiSelect: false, isOther: false,
  isSecret: false, options: [{ label: `选项${id}`, description: '说明' }],
})

it('多个问题分页作答，跳过在左、下一题或提交在右', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const onSubmit = vi.fn()
  const approval = { requestId: 1, title: '提问', questions: [question('a'), question('b')] } as unknown as ApprovalView
  const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text)!
  const footer = () => [...host.querySelectorAll('[aria-busy] button')].map((item) => item.textContent)
  const click = (text: string) => act(() => { button(text).click() })
  try {
    await act(() => root.render(<UserInputCard approval={approval} submitting={false} offline={false} onSubmit={onSubmit} />))
    expect(host.querySelectorAll('fieldset')).toHaveLength(1)
    expect(footer()).toEqual(['跳过', '下一题'])
    await click('选项a说明')
    await click('下一题')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(footer()).toEqual(['跳过', '提交回答'])
    await click('选项b说明')
    await click('提交回答')
    expect(onSubmit).toHaveBeenCalledWith({ a: ['选项a'], b: ['选项b'] })
  } finally {
    await act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
