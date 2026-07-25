// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DefinitionPreview from './DefinitionPreview'
import { useDefinitionPreviewStore } from '../store/definitionPreviewStore'

const mocks = vi.hoisted(() => ({
  jumpToDefinitionCandidate: vi.fn(),
}))

vi.mock('../lib/definitionNavigation', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/definitionNavigation')>()
  return {
    ...original,
    jumpToDefinitionCandidate: mocks.jumpToDefinitionCandidate,
  }
})

describe('DefinitionPreview', () => {
  beforeEach(() => {
    mocks.jumpToDefinitionCandidate.mockReset()
    useDefinitionPreviewStore.getState().closePreview(true)
  })

  it('shows an anchored definition preview and exposes navigation actions', () => {
    const findUsages = vi.fn()
    const store = useDefinitionPreviewStore.getState()
    store.beginPreview({
      requestId: 7,
      symbol: 'xu_logger',
      anchor: { left: 120, top: 80, right: 180, bottom: 98 },
      onFindUsages: findUsages,
    })
    store.completePreview(7, [
      {
        name: 'xu_logger',
        kind: 'variable',
        path: 'D:/work/logger.py',
        relative: 'logger.py',
        line: 12,
        column: 1,
        text: 'xu_logger = XuLogger()',
        score: 2400,
        confidence: 'bound',
        approximate: false,
      },
    ])

    render(<DefinitionPreview />)

    expect(screen.getByRole('dialog')).toHaveTextContent('xu_logger')
    expect(screen.getByRole('dialog')).toHaveTextContent('logger.py')
    expect(screen.getByRole('dialog')).toHaveTextContent('xu_logger = XuLogger()')

    fireEvent.click(screen.getByRole('button', { name: '查找用法' }))
    expect(findUsages).toHaveBeenCalledTimes(1)
  })
})
