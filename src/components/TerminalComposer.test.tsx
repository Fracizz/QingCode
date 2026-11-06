// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalComposer from './TerminalComposer'
import { useTerminalDraftStore } from '../store/terminalDraftStore'

vi.mock('../lib/tauri', () => ({ isTauri: () => false }))
vi.mock('../utils/fileReferences', () => ({ copyToClipboard: vi.fn(async () => {}) }))

beforeEach(() => useTerminalDraftStore.setState({ drafts: {} }))
const props = () => ({
  terminalId: 't1',
  terminalName: 'Claude',
  onClose: vi.fn(),
  onFill: vi.fn(() => true),
  prepareClipboard: vi.fn(async () => "'/tmp/截图.png'"),
  prepareFiles: vi.fn(async () => "'/tmp/a b.txt'"),
  prepareFilePaths: vi.fn(async () => "'/tmp/native.png'"),
})

describe('long terminal input', () => {
  it('retains separate drafts when dismissed and sends exact whitespace only on explicit fill', () => {
    const callbacks = props()
    const first = render(<TerminalComposer {...callbacks} />)
    fireEvent.change(screen.getByRole('textbox', { name: '长文本内容' }), {
      target: { value: '  第一段\n第二段\n' },
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true })
    expect(callbacks.onFill).not.toHaveBeenCalled()
    first.unmount()
    const other = render(<TerminalComposer {...callbacks} terminalId="t2" />)
    expect(screen.getByRole('textbox')).toHaveValue('')
    other.unmount()
    render(<TerminalComposer {...callbacks} />)
    expect(screen.getByRole('textbox')).toHaveValue('  第一段\n第二段\n')
    fireEvent.click(screen.getByRole('button', { name: '填入终端' }))
    expect(callbacks.onFill).toHaveBeenCalledWith('  第一段\n第二段\n')
    expect(useTerminalDraftStore.getState().drafts.t1).toBe('')
  })

  it('keeps the draft when the target rejects multiline input', () => {
    const callbacks = props()
    callbacks.onFill.mockReturnValue(false)
    render(<TerminalComposer {...callbacks} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first\nsecond' } })
    fireEvent.click(screen.getByRole('button', { name: '填入终端' }))
    expect(screen.getByRole('alert')).toHaveTextContent('手动粘贴')
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('first\nsecond')
  })

  it('inserts screenshot references at the selection and does not submit the terminal', async () => {
    const callbacks = props()
    render(<TerminalComposer {...callbacks} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '分析这里的图片' } })
    input.setSelectionRange(2, 4)
    fireEvent.paste(input, { clipboardData: { files: [], getData: () => '' } })
    await waitFor(() => expect(input.value).toBe("分析 '/tmp/截图.png' 的图片"))
    expect(callbacks.onFill).not.toHaveBeenCalled()
  })

  it('adds browser files and keeps plain text paste on the native textarea path', async () => {
    const callbacks = props()
    render(<TerminalComposer {...callbacks} />)
    expect(
      fireEvent.paste(screen.getByRole('textbox'), {
        clipboardData: { files: [], getData: () => '普通文字' },
      })
    ).toBe(true)
    const file = new File(['data'], 'a b.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('选择终端附件'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue("'/tmp/a b.txt' "))
    expect(callbacks.prepareFiles).toHaveBeenCalledWith([file])
  })

  it('shows the target terminal and attachment hint in one header subtitle', () => {
    render(<TerminalComposer {...props()} />)
    const subtitle = document.querySelector('[data-terminal-composer-subtitle]')!
    expect(subtitle).toHaveTextContent('填入终端：Claude · 支持粘贴图片、文件和拖入附件')
    expect(screen.getAllByText(/支持粘贴图片/)).toHaveLength(1)
  })

  it('floats without a backdrop and only closes on Escape while focused inside', () => {
    const callbacks = props()
    render(<TerminalComposer {...callbacks} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(document.querySelector('[data-modal-overlay]')).toBeNull()
    expect(screen.getByRole('textbox')).toHaveFocus()
    // 焦点在终端时 Escape 属于 Claude/OpenCode，不能关闭面板
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(callbacks.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
  })

  it('drags by the title bar, remembers the position and resets on double click', async () => {
    localStorage.clear()
    vi.stubGlobal('PointerEvent', MouseEvent)
    const callbacks = props()
    const first = render(<TerminalComposer {...callbacks} />)
    const dialog = screen.getByRole('dialog')
    const handle = dialog.querySelector('[data-terminal-composer-handle]')!
    const startLeft = parseFloat(dialog.style.left)
    const startTop = parseFloat(dialog.style.top)
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 130 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: 130 })
    await waitFor(() => expect(parseFloat(dialog.style.left)).toBe(startLeft - 40))
    expect(parseFloat(dialog.style.top)).toBe(startTop + 30)
    first.unmount()
    render(<TerminalComposer {...callbacks} />)
    const reopened = screen.getByRole('dialog')
    expect(parseFloat(reopened.style.left)).toBe(startLeft - 40)
    fireEvent.doubleClick(reopened.querySelector('[data-terminal-composer-handle]')!)
    expect(parseFloat(reopened.style.left)).toBe(startLeft)
    expect(parseFloat(reopened.style.top)).toBe(startTop)
    vi.unstubAllGlobals()
  })

  it('stays mounted with its draft while the target terminal is hidden', () => {
    const callbacks = props()
    const view = render(<TerminalComposer {...callbacks} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '对照终端' } })
    view.rerender(<TerminalComposer {...callbacks} hidden />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<TerminalComposer {...callbacks} />)
    expect(screen.getByRole('textbox')).toHaveValue('对照终端')
  })

  it.each([
    'D:/code/django',
    '"D:\\code\\django"',
    '/tmp/not-created-yet.txt',
    'file:///D:/code/django',
  ])('keeps path text on the native textarea paste path: %s', text => {
    const callbacks = props()
    render(<TerminalComposer {...callbacks} />)
    expect(fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { files: [], getData: () => text },
    })).toBe(true)
    expect(callbacks.prepareClipboard).not.toHaveBeenCalled()
  })
})
