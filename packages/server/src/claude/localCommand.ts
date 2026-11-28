/**
 * Claude Code 终端里执行的本地斜杠命令（/model、/clear 等）不会发给模型，但会以带标签的用户消息写进会话记录：
 * - `<local-command-caveat>`：提示模型忽略本地命令的说明，用户从未输入过；
 * - `<command-name>/model</command-name><command-message>…<command-args>sonnet</command-args>`：用户输入的命令；
 * - `<local-command-stdout>` / `<local-command-stderr>`：命令在终端里的输出；
 * - `<bash-input>`、`<bash-stdout>` / `<bash-stderr>`：用 `!` 直接执行的终端命令及输出。
 * 历史回放时原样显示会是一串标签，这里还原成用户看到的样子（纯函数）。
 */
export type LocalCommand =
  | { kind: 'skip' }
  | { kind: 'command'; text: string }
  | { kind: 'output'; text: string }

function tag(name: string, value: string): string | undefined {
  const open = `<${name}>`
  const start = value.indexOf(open)
  if (start < 0) return undefined
  const end = value.indexOf(`</${name}>`, start + open.length)
  return end < 0 ? undefined : value.slice(start + open.length, end)
}

// 终端输出可能带颜色控制序列，界面上会显示成乱码。
// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    // 带图片或工具回执的消息不是本地命令记录。
    if (record.type !== 'text' || typeof record.text !== 'string') return undefined
    texts.push(record.text)
  }
  return texts.join('\n')
}

/** 终端输出按代码块展示；围栏比正文里最长的反引号串更长，避免提前闭合。 */
function codeBlock(value: string): string {
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${value}\n${fence}`
}

function parseShell(value: string): LocalCommand | undefined {
  if (value.startsWith('<bash-input>') && value.endsWith('</bash-input>')) {
    const command = tag('bash-input', value)?.trim()
    return command ? { kind: 'command', text: `!${command}` } : { kind: 'skip' }
  }
  if (!/^<bash-(stdout|stderr)>/.test(value) || !/<\/bash-(stdout|stderr)>$/.test(value)) return undefined
  const output = stripAnsi([tag('bash-stdout', value), tag('bash-stderr', value)].filter(Boolean).join('\n')).trim()
  return output ? { kind: 'output', text: codeBlock(output) } : { kind: 'skip' }
}

export function parseLocalCommand(content: unknown): LocalCommand | undefined {
  const value = contentText(content)?.trim()
  if (!value || !value.startsWith('<')) return undefined
  if (value.startsWith('<local-command-caveat>')) return { kind: 'skip' }
  if (value.startsWith('<bash-')) return parseShell(value)
  const name = tag('command-name', value)?.trim()
  if (name && value.startsWith('<command-')) {
    const args = tag('command-args', value)?.trim()
    return { kind: 'command', text: args ? `${name} ${args}` : name }
  }
  const stdout = tag('local-command-stdout', value)
  const stderr = tag('local-command-stderr', value)
  if (stdout === undefined && stderr === undefined) return undefined
  const text = stripAnsi([stdout, stderr].filter(Boolean).join('\n')).trim()
  return text ? { kind: 'output', text } : { kind: 'skip' }
}
