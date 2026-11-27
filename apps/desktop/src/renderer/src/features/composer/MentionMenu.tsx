import { File as FileIcon } from 'lucide-react'
import { getLocale, t } from '@qn/codex-client'
import { ListOption } from '../../components/ListOption'
import { LoadingIcon } from '../../components/LoadingIcon'
import { EmptyState, ErrorNote } from '../../components/ui'
import type { MentionCandidate } from './mentions'
import { Suggestions } from './Suggestions'

/** `@` 候选列表：浮在输入框上方，交互与斜杠菜单一致（键盘由输入框统一处理）。 */
export function MentionMenu({
  items,
  active,
  query,
  searching,
  error,
  onHover,
  onChoose,
}: {
  items: MentionCandidate[]
  active: number
  query: string
  searching: boolean
  error: string | null
  onHover: (index: number) => void
  onChoose: (item: MentionCandidate) => void
}) {
  const empty = query.trim() === '' ? t('输入文件名搜索项目文件') : searching ? t('正在搜索…') : t('没有匹配的文件')

  return (
    <Suggestions
      label={t('引用文件')}
      active={active}
      // i18n-ignore: 与引用选中文字的“引用”同形而英文含义不同，不能共用词条
      confirmHint={getLocale() === 'en' ? 'Mention' : '引用'}
      trailingHint={searching && items.length > 0 && (
        <span className="ml-auto flex items-center gap-1">
          <LoadingIcon size={11} /> {t('搜索中')}
        </span>
      )}
    >
      {items.length === 0 && (error ? (
        <ErrorNote message={error} variant="compact" />
      ) : (
        <EmptyState className="flex items-center justify-center gap-1.5 py-3 leading-5">
          {searching && <LoadingIcon size={12} />}
          {empty}
        </EmptyState>
      ))}
      {items.map((item, index) => (
        <ListOption
          key={item.path}
          data-index={index}
          selected={index === active}
          className="py-1.5"
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(item)}
        >
          <FileIcon size={14} className="shrink-0 text-qn-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui text-qn-text">{item.name}</span>
            <span className="block truncate text-ui-sm text-qn-dim">{item.relative}</span>
          </span>
        </ListOption>
      ))}
    </Suggestions>
  )
}
