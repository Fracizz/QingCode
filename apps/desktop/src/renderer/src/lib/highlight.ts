/** 代码块语言名归一：Markdown 里常见的简写/别名映射到 shiki 的语言 id；无法识别时返回 null 表示按纯文本显示。 */
const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellscript: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  rb: 'ruby',
  dockerfile: 'docker',
  conf: 'ini',
  toml: 'toml',
  patch: 'diff',
  jsonc: 'jsonc',
  json5: 'json5',
  html: 'html',
  vue: 'vue',
  sql: 'sql',
}

const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'output', 'log'])

export function normalizeLang(raw: string | null | undefined): string | null {
  const name = (raw ?? '').trim().toLowerCase()
  if (PLAIN.has(name)) return null
  return ALIASES[name] ?? name
}

/** react-markdown 把 ```lang 写成 className="language-lang"。 */
export function langFromClassName(className: string | null | undefined): string | null {
  const match = /(?:^|\s)language-([^\s]+)/.exec(className ?? '')
  return match ? normalizeLang(match[1]) : null
}

/** 超长代码块（日志、生成文件）不做高亮，避免卡住渲染线程。 */
export const HIGHLIGHT_MAX_CHARS = 60_000

export function shouldHighlight(code: string, lang: string | null): lang is string {
  return lang !== null && code.length <= HIGHLIGHT_MAX_CHARS
}
