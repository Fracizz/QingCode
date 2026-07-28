// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DefinitionPicker from './DefinitionPicker'
import { useDefinitionPickerStore } from '../store/definitionPickerStore'
import { useEditorStore } from '../store/editorStore'

const initialEditorState = useEditorStore.getState()

describe('DefinitionPicker', () => {
  beforeEach(() => {
    useDefinitionPickerStore.getState().closePicker()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useEditorStore.setState(initialEditorState, true)
  })

  it('runs the Ctrl+click continuation after a chosen definition is opened', async () => {
    const openFile = vi.fn().mockResolvedValue(undefined)
    const afterDefinitionJump = vi.fn()
    useEditorStore.setState({ openFile })
    useDefinitionPickerStore.getState().openPicker(
      'selectedName',
      [
        {
          name: 'selectedName',
          kind: 'function',
          path: 'D:/work/definition.ts',
          relative: 'definition.ts',
          line: 12,
          column: 3,
          text: 'function selectedName() {}',
          score: 1000,
        },
      ],
      'definition',
      {},
      undefined,
      afterDefinitionJump
    )

    render(<DefinitionPicker />)
    fireEvent.click(screen.getByRole('option'))

    await waitFor(() => expect(openFile).toHaveBeenCalledWith('D:/work/definition.ts', 12, 3))
    await waitFor(() =>
      expect(afterDefinitionJump).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'D:/work/definition.ts', line: 12 })
      )
    )
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
    expect(dialog.className).toContain('bg-bg-elevated/95')
    expect(dialog.className).not.toContain('backdrop-blur')
    const dragHandle = screen.getByLabelText('拖动用法浮层')
    expect(dragHandle).toHaveClass('cursor-move')
    expect(dialog).not.toHaveAttribute('aria-modal')
    expect(dialog).toHaveTextContent('xu_logger.info("ready")')

    const initialLeft = dialog.style.left
    const initialTop = dialog.style.top
    const animationFrames = new Map<number, FrameRequestCallback>()
    let nextAnimationFrame = 0
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        const id = ++nextAnimationFrame
        animationFrames.set(id, callback)
        return id
      })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      animationFrames.delete(id)
    })
    const pointerEvent = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY })
      Object.defineProperty(event, 'pointerId', { value: 7 })
      Object.defineProperty(event, 'isPrimary', { value: true })
      return event
    }
    fireEvent(dragHandle, pointerEvent('pointerdown', 120, 70))
    expect(dialog.dataset.dragging).toBe('true')
    fireEvent(dragHandle, pointerEvent('pointermove', 180, 110))
    fireEvent(dragHandle, pointerEvent('pointermove', 200, 130))
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    animationFrames.get(1)?.(0)
    expect(dialog.style.transform).toContain('translate3d')
    fireEvent(dragHandle, pointerEvent('pointerup', 180, 110))

    expect(dialog.style.left).not.toBe(initialLeft)
    expect(dialog.style.top).not.toBe(initialTop)
    expect(dialog.style.transform).toBe('')
    expect(dialog.dataset.dragging).toBeUndefined()

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
    expect(screen.getByText('当前文件')).toBeInTheDocument()
    expect(screen.getByText('按调用者 / 文件分组')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '用法分组 submitOrder' })).toBeInTheDocument()
    expect(group).toHaveTextContent('2 处')
    expect(screen.getByRole('dialog')).toHaveTextContent('await processOrder(retry)')

    const options = screen.getAllByRole('option')
    fireEvent.mouseEnter(options[1])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(group)

    expect(screen.getByRole('button', { name: '展开用法分组 submitOrder' })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).not.toHaveTextContent('await processOrder(retry)')
  })

  it('renders large usage results in lightweight batches', () => {
    const candidates = Array.from({ length: 75 }, (_, index) => ({
      name: 'renderBatch',
      kind: 'function',
      path: `D:/work/file-${index}.ts`,
      relative: `file-${index}.ts`,
      line: index + 1,
      column: 1,
      text: `renderBatch(${index})`,
      score: 1000,
      usageKind: 'call' as const,
    }))
    useDefinitionPickerStore.getState().openPicker('renderBatch', candidates, 'reference', {
      kind: 'function',
      totalCount: candidates.length,
      complete: true,
      anchor: { left: 100, top: 60, right: 160, bottom: 78 },
    })

    render(<DefinitionPicker />)

    expect(screen.getAllByRole('option')).toHaveLength(60)
    expect(screen.getByText('项目文件')).toBeInTheDocument()
    expect(screen.getByText('显示 60 / 75')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '显示更多用法' }))

    expect(screen.getAllByRole('option')).toHaveLength(75)
    expect(screen.getByText('显示 75 / 75')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '显示更多用法' })).not.toBeInTheDocument()
  })

  it('shows an anchored loading shell before usage results arrive', () => {
    useDefinitionPickerStore.getState().openPicker('pendingUsage', [], 'reference', {
      kind: 'function',
      totalCount: 0,
      complete: false,
      loading: true,
      requestId: 7,
      anchor: { left: 100, top: 60, right: 160, bottom: 78 },
    })

    render(<DefinitionPicker />)

    expect(screen.getByRole('dialog')).toHaveClass('fixed')
    expect(screen.getAllByText('正在加载用法…')).toHaveLength(2)
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })
})
