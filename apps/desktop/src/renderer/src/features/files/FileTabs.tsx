import { useLayoutEffect, useRef } from 'react'
import { FileDiff, FileText, Image as ImageIcon, TriangleAlert, X } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { LoadingIcon } from '../../components/LoadingIcon'
import { StatusDot } from '../../components/StatusDot'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../../components/primitives'
import { IconButton } from '../../components/ui'
import { cn } from '../../lib/cn'
import { basename, dirname, fileKind } from './fileLinks'
import type { Tab } from './filesModel'
import { useFiles } from './filesStore'

export function FileTabs({ tabs, activeId }: { tabs: Tab[]; activeId: string | undefined }) {
  const activate = useFiles((state) => state.activate)
  const requestClose = useFiles((state) => state.requestClose)
  const requestCloseAll = useFiles((state) => state.requestCloseAll)
  const activeTab = useRef<HTMLDivElement>(null)
  const closeTabs = (items: Tab[]) => requestCloseAll(items.map((tab) => tab.id))

  useLayoutEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  return (
    <div className="min-w-0 flex-1 self-stretch overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:h-[3px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-qn-border-strong">
      <div role="tablist" aria-label="文件标签" className="flex h-[calc(var(--spacing)*9-1px)] w-max items-center gap-1">
        {tabs.map((tab, index) => (
          <ContextMenu.Root key={tab.id}>
            <ContextMenu.Trigger asChild>
              <div
                ref={tab.id === activeId ? activeTab : undefined}
                role="tab"
                aria-selected={tab.id === activeId}
                tabIndex={0}
                title={tab.path}
                onClick={() => activate(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) requestClose(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activate(tab.id)
                  }
                }}
                className={cn(
                  'group/tab flex h-7 min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                  tab.id === activeId ? 'bg-qn-active text-qn-text' : 'text-qn-muted hover:bg-qn-hover',
                )}
              >
                {tab.busy || tab.saving ? (
                  <LoadingIcon size={12} className="text-qn-brand" />
                ) : tab.kind === 'diff' ? (
                  <FileDiff size={12} className="shrink-0 text-qn-dim" />
                ) : fileKind(tab.path) === 'image' ? (
                  <ImageIcon size={12} className="shrink-0 text-qn-dim" />
                ) : (
                  <FileText size={12} className="shrink-0 text-qn-dim" />
                )}
                {tab.dirty && <StatusDot className="bg-qn-warn" title="未保存" />}
                {tab.diskChanged && (
                  <span className="shrink-0" title="磁盘已更改" aria-label="磁盘已更改">
                    <TriangleAlert size={11} className="text-qn-danger" />
                  </span>
                )}
                <span className="truncate">{basename(tab.path) || tab.path}</span>
                <span className="truncate text-[11px] text-qn-dim">{basename(dirname(tab.path))}</span>
                <IconButton
                  label={`关闭 ${basename(tab.path)}`}
                  size="sm"
                  tooltip={false}
                  className="ml-auto size-4 text-qn-dim"
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    requestClose(tab.id)
                  }}
                >
                  <X size={11} />
                </IconButton>
              </div>
            </ContextMenu.Trigger>
            <ContextMenuContent aria-label="文件标签操作">
              <ContextMenuItem onSelect={() => requestClose(tab.id)}>关闭标签</ContextMenuItem>
              <ContextMenuItem disabled={tabs.length < 2}
                onSelect={() => closeTabs(tabs.filter((item) => item.id !== tab.id))}>
                关闭其他标签
              </ContextMenuItem>
              <ContextMenuItem disabled={index === 0} onSelect={() => closeTabs(tabs.slice(0, index))}>
                关闭左侧标签
              </ContextMenuItem>
              <ContextMenuItem disabled={index === tabs.length - 1} onSelect={() => closeTabs(tabs.slice(index + 1))}>
                关闭右侧标签
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => closeTabs(tabs)}>关闭全部标签</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu.Root>
        ))}
      </div>
    </div>
  )
}
