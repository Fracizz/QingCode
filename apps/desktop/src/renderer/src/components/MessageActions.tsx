import { useState } from 'react'
import { Check, Copy, MoreHorizontal, Split } from 'lucide-react'
import { t } from '@qn/codex-client'
import { copyText } from '../lib/clipboard'
import { markdownToPlainText } from '../lib/markdown'
import { Menu, MenuContent, MenuItem, MenuTrigger } from './primitives'
import { IconButton } from './ui'

/** 回复下方的操作条：平时半隐，悬停消息时显出（参考 Codex），避免每条回复都挂一排按钮。 */
export function MessageActions({
  markdown,
  onFork,
}: {
  markdown: string
  onFork?: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (value: string, label: string) => {
    const ok = await copyText(value)
    setCopied(ok ? label : t('复制失败'))
    window.setTimeout(() => setCopied(null), 1600)
  }

  return (
    <div className="mt-1 flex h-7 items-center gap-0.5 text-ui-sm text-qn-muted opacity-0 transition-opacity group-hover/msg:opacity-100 has-[[data-state=open]]:opacity-100">
      <IconButton label={t('复制 Markdown 原文')} className="h-7 w-7" onClick={() => void copy(markdown, t('已复制'))}>
        {copied ? <Check size={14} className="text-qn-ok" /> : <Copy size={14} />}
      </IconButton>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t('更多操作')} className="h-7 w-7">
            <MoreHorizontal size={15} />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<Copy size={14} />} onSelect={() => void copy(markdownToPlainText(markdown), t('已复制纯文本'))}>
            {t('复制为纯文本')}
          </MenuItem>
          {onFork && (
            <MenuItem icon={<Split size={14} />} onSelect={onFork}>
              {t('分支到新聊天')}
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {copied && <span className="ml-1 text-qn-ok">{copied}</span>}
    </div>
  )
}
