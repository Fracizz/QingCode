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
})
