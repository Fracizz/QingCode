import { describe, expect, it } from 'vitest'
import {
  CLEAR_INPUT_EMACS,
  CLEAR_INPUT_MULTILINE_STEP,
  CLEAR_INPUT_WINDOWS,
  multilineClearInputSequence,
  splitClearInputSequence,
  terminalClearInputSequence,
} from './terminalClearInput'

const ESC = '\x1b'
const DELETE_KEY = `${ESC}[3~`

describe('terminalClearInputSequence', () => {
  it('AI CLI（bracketed paste）在任何 Shell 里都按行清除多行输入，不发单独的 Esc', () => {
    for (const shell of ['powershell', 'pwsh', 'cmd', 'bash', 'auto', undefined] as const) {
      const sequence = terminalClearInputSequence({
        shell,
        windowsHost: true,
        bracketedPaste: true,
        rows: 30,
      })
      expect(sequence).toBe(multilineClearInputSequence(30))
      expect(sequence.startsWith(CLEAR_INPUT_MULTILINE_STEP)).toBe(true)
      expect(sequence.endsWith(CLEAR_INPUT_EMACS)).toBe(true)
      // 去掉 Delete 键序列后不应再有 Esc（Claude Code 会把 Esc 当作中断）。
      expect(sequence.split(DELETE_KEY).join('')).not.toContain(ESC)
    }
  })

  it('多行清除轮次按可见行数估计，并有上下限', () => {
    const rounds = (rows?: number) =>
      (multilineClearInputSequence(rows).length - CLEAR_INPUT_EMACS.length) /
      CLEAR_INPUT_MULTILINE_STEP.length
    expect(rounds()).toBe(24)
    expect(rounds(10)).toBe(24)
    expect(rounds(50)).toBe(50)
    expect(rounds(10_000)).toBe(200)
  })

  it('多行清除序列能清空任意光标位置的多行输入', () => {
    // 按「行尾 / 删到行首 / 退格并行 / 删除并行」语义模拟多行输入框。
    const simulate = (lines: string[], row: number, col: number, keys: string) => {
      const text = [...lines]
      let r = row
      let c = col
      let i = 0
      while (i < keys.length) {
        if (keys.startsWith(DELETE_KEY, i)) {
          if (c < text[r].length) text[r] = text[r].slice(0, c) + text[r].slice(c + 1)
          else if (r < text.length - 1) {
            text[r] += text[r + 1]
            text.splice(r + 1, 1)
          }
          i += DELETE_KEY.length
          continue
        }
        const key = keys[i]
        i += 1
        if (key === '\x05') c = text[r].length
        else if (key === '\x15') {
          text[r] = text[r].slice(c)
          c = 0
        } else if (key === '\x7f') {
          if (c > 0) {
            text[r] = text[r].slice(0, c - 1) + text[r].slice(c)
            c -= 1
          } else if (r > 0) {
            c = text[r - 1].length
            text[r - 1] += text[r]
            text.splice(r, 1)
            r -= 1
          }
        }
      }
      return text.join('\n')
    }
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`)
    for (const row of [0, 7, 19]) {
      expect(simulate(lines, row, 2, multilineClearInputSequence(24))).toBe('')
    }
  })

  it('Windows Shell 提示符用 Esc 清空整行', () => {
    for (const shell of ['powershell', 'pwsh', 'cmd'] as const) {
      expect(terminalClearInputSequence({ shell, windowsHost: false, bracketedPaste: false })).toBe(
        CLEAR_INPUT_WINDOWS
      )
    }
  })

  it('POSIX Shell 提示符用 Ctrl+E Ctrl+U', () => {
    for (const shell of ['bash', 'zsh', 'wsl'] as const) {
      expect(terminalClearInputSequence({ shell, windowsHost: true, bracketedPaste: false })).toBe(
        CLEAR_INPUT_EMACS
      )
    }
  })

  it('Shell 未解析时按主机系统选择', () => {
    expect(
      terminalClearInputSequence({ shell: 'auto', windowsHost: true, bracketedPaste: false })
    ).toBe(CLEAR_INPUT_WINDOWS)
    expect(
      terminalClearInputSequence({ shell: undefined, windowsHost: false, bracketedPaste: false })
    ).toBe(CLEAR_INPUT_EMACS)
  })
})

describe('splitClearInputSequence', () => {
  it('多行序列按轮次拆开，拼回去与原序列一致', () => {
    const sequence = multilineClearInputSequence(40)
    const chunks = splitClearInputSequence(sequence)
    expect(chunks).toHaveLength(41)
    expect(chunks.slice(0, 40).every(chunk => chunk === CLEAR_INPUT_MULTILINE_STEP)).toBe(true)
    expect(chunks[40]).toBe(CLEAR_INPUT_EMACS)
    expect(chunks.join('')).toBe(sequence)
  })

  it('单行序列不拆分', () => {
    expect(splitClearInputSequence(CLEAR_INPUT_EMACS)).toEqual([CLEAR_INPUT_EMACS])
    expect(splitClearInputSequence(CLEAR_INPUT_WINDOWS)).toEqual([CLEAR_INPUT_WINDOWS])
  })
})
