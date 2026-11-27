import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ThemedTokenWithVariants } from 'shiki/core'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../lib/clipboard'
import { shouldHighlight } from '../lib/highlight'
import { highlightTokens } from '../lib/shiki'

// shiki FontStyle 位标记：1 斜体、2 粗体、4 下划线。颜色交给 .qn-tk 按主题从两个变量里取。
function tokenStyle(token: ThemedTokenWithVariants): CSSProperties {
  const { dark, light } = token.variants
  const flags = dark?.fontStyle ?? 0
  return {
    '--qn-tk-dark': dark?.color,
    '--qn-tk-light': light?.color,
    fontStyle: flags & 1 ? 'italic' : undefined,
    fontWeight: flags & 2 ? 600 : undefined,
    textDecoration: flags & 4 ? 'underline' : undefined,
  } as CSSProperties
}

/**
 * 代码块（参考 Codex：顶部一行语言名 + 复制，正文语法高亮）。
 * 流式生成中不高亮——每个增量都重算 token 会卡；生成结束后一次性着色。
 */
export function CodeBlock({ code, lang, streaming = false }: { code: string; lang: string | null; streaming?: boolean }) {
  const [tokens, setTokens] = useState<ThemedTokenWithVariants[][] | null>(null)
  const [copied, setCopied] = useState(false)
  const value = code.replace(/\n$/, '')

  useEffect(() => {
    setTokens(null)
    if (streaming || !shouldHighlight(value, lang)) return
    let alive = true
    void highlightTokens(value, lang).then((result) => {
      if (alive) setTokens(result)
    })
    return () => {
      alive = false
    }
  }, [value, lang, streaming])

  const copy = async () => {
    if (!(await copyText(value))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-qn-border bg-qn-code">
      <div className="flex h-8 items-center justify-between border-b border-qn-border/70 pl-3.5 pr-1.5 text-ui-sm text-qn-dim">
        <span className="font-mono">{lang ?? 'text'}</span>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-qn-muted opacity-70 hover:bg-qn-hover hover:text-qn-text group-hover/code:opacity-100"
          onClick={() => void copy()}
          aria-label="复制代码"
        >
          {copied ? <Check size={13} className="text-qn-ok" /> : <Copy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="qn-pre qn-scroll">
        <code>
          {tokens
            ? tokens.map((line, index) => (
                <span key={index} className="block">
                  {line.length === 0
                    ? ' '
                    : line.map((token, i) => (
                        <span key={i} className="qn-tk" style={tokenStyle(token)}>
                          {token.content}
                        </span>
                      ))}
                </span>
              ))
            : value}
        </code>
      </pre>
    </div>
  )
}
