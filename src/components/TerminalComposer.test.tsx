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

  it('preserves a pasted path when no attachment is found', async () => {
    const callbacks = props()
    render(<TerminalComposer {...callbacks} prepareClipboard={async () => null} />)
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { files: [], getData: () => '/tmp/not-created-yet.txt' },
    })
    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue('/tmp/not-created-yet.txt ')
    )
  })
})
