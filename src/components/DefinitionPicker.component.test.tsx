// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import DefinitionPicker from './DefinitionPicker'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'

describe('DefinitionPicker', () => {
  beforeEach(() => {
    useDefinitionPickerStore.getState().closePicker()
  })

  it('shows reference results as an anchored non-modal popup', () => {
    useDefinitionPickerStore.getState().openPicker(
      'xu_logger',
      [
        {
          name: 'xu_logger',
          kind: 'variable',
          path: 'D:/work/main.py',
          relative: 'main.py',
          line: 8,
          column: 3,
          text: 'xu_logger.info("ready")',
          score: 1000,
          usageKind: 'read',
        },
      ],
      'reference',
      {
        kind: 'variable',
        totalCount: 1,
        complete: true,
        anchor: { left: 100, top: 60, right: 160, bottom: 78 },
      }
    )

    render(<DefinitionPicker />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('fixed')
    expect(dialog).not.toHaveAttribute('aria-modal')
    expect(dialog).toHaveTextContent('xu_logger.info("ready")')

    fireEvent.pointerDown(document.body)
    expect(useDefinitionPickerStore.getState().open).toBe(false)
  })

  it('groups reference locations by caller and supports collapsing a group', () => {
    useDefinitionPickerStore.getState().openPicker(
      'processOrder',
      [
        {
          name: 'processOrder',
          kind: 'function',
          path: 'D:/work/order.py',
          relative: 'order.py',
          line: 8,
          column: 3,
          text: 'processOrder(order)',
          score: 1000,
          usageKind: 'call',
          callerName: 'submitOrder',
          callerKind: 'function',
        },
        {
          name: 'processOrder',
          kind: 'function',
          path: 'D:/work/order.py',
          relative: 'order.py',
          line: 12,
          column: 3,
          text: 'await processOrder(retry)',
          score: 1000,
          usageKind: 'call',
          callerName: 'submitOrder',
          callerKind: 'function',
        },
      ],
      'reference',
      {
        kind: 'function',
        totalCount: 2,
        complete: true,
        anchor: { left: 100, top: 60, right: 160, bottom: 78 },
      }
    )

    render(<DefinitionPicker />)

    const group = screen.getByRole('button', { name: '折叠用法分组 submitOrder' })
    expect(group).toHaveTextContent('2 处')
    expect(screen.getByRole('dialog')).toHaveTextContent('await processOrder(retry)')

    fireEvent.click(group)

    expect(
      screen.getByRole('button', { name: '展开用法分组 submitOrder' })
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).not.toHaveTextContent('await processOrder(retry)')
  })
})
