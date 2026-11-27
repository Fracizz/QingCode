import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Zap } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import { cn } from '../lib/cn'
import {
  contextUsage,
  EMPTY_PREFS,
  effortHint,
  effortLabel,
  filterModels,
  formatTokens,
  localizeModelDescription,
  resolveSelection,
  triggerLabel,
} from '../lib/models'
import { useCodex } from '../store/codex'
import { useModels } from '../store/models'
import { ListOption } from './ListOption'
import { LoadingIcon } from './LoadingIcon'
import { ProgressRing } from './ProgressRing'
import { PopoverContent, PopoverRoot, PopoverTrigger, Tip } from './primitives'
import { SearchField } from './SearchField'
import { EmptyState, ErrorNote, Spinner } from './ui'

/**
 * 输入框里的模型选择器（参考 Codex）：搜索模型 → 选模型 → 推理强度分段 → 速度（Fast）开关。
 * 选择按 agent 记在本机，发送时作为 turn/start 的 model / effort / serviceTier 覆盖项。
 * Codex / Claude / pi 都走 model/list；列表为空时不渲染。
 */
export function ModelPicker({ targetId, agent }: { targetId: string; agent: AgentKind }) {
  const key = sessionKey(targetId, agent)
  const session = useCodex((s) => s.sessions[key])
  const list = useModels((s) => s.lists[key])
  const prefs = useModels((s) => s.prefs[agent] ?? EMPTY_PREFS)
  const load = useModels((s) => s.load)
  const setPrefs = useModels((s) => s.setPrefs)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const opened = session?.opened === true
  useEffect(() => {
    if (opened && session) void load(targetId, agent, session.rpc)
  }, [opened, session, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const visible = useMemo(() => filterModels(models, query), [models, query])

  if (!opened || (models.length === 0 && !list?.loading && !list?.error)) return null

  const pick = (model: string) => {
    const option = models.find((item) => item.model === model)
    // 换模型时强度若不被新模型支持，交给 resolveSelection 回落到默认，这里不清空偏好里的强度。
    setPrefs(agent, { model, ...(option && prefs.effort && !option.efforts.some((e) => e.value === prefs.effort) ? { effort: null } : {}) })
  }

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 max-w-[16rem] items-center gap-1 rounded-lg px-2 text-[13px] text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=open]:bg-qn-hover data-[state=open]:text-qn-text"
          aria-label="选择模型与推理强度"
        >
          {list?.loading && models.length === 0 ? (
            <LoadingIcon size={13} />
          ) : (
            selection.fast && <Zap size={13} className="shrink-0 text-qn-warn" />
          )}
          <span className="truncate">{triggerLabel(selection) || '模型'}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[min(420px,calc(100vw-32px))] overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <SearchField
          ref={searchRef}
          label="搜索模型"
          className="gap-2.5 border-b border-qn-border px-3.5 py-3"
          inputClassName="text-[14px]"
          placeholder="搜索模型…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible[0]) {
              event.preventDefault()
              pick(visible[0].model)
              setQuery('')
            }
          }}
        />

        <div className="qn-scroll max-h-[min(320px,45vh)] space-y-1 overflow-y-auto p-1.5" role="listbox" aria-label="模型">
          <ErrorNote
            message={list?.error ?? null}
            variant="compact"
            onRetry={() => session && void load(targetId, agent, session.rpc, true)}
          />
          {list?.loading && models.length === 0 && (
            <div className="px-2.5 py-3"><Spinner label="正在加载模型…" /></div>
          )}
          {!list?.loading && visible.length === 0 && models.length > 0 && (
            <EmptyState className="px-2.5 py-3 leading-5">没有匹配的模型</EmptyState>
          )}
          {visible.map((model) => {
            const selected = model.model === selection.model?.model
            return (
              <ListOption
                key={model.id}
                selected={selected}
                className="px-3 py-2.5"
                onClick={() => pick(model.model)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-qn-text">{model.displayName}</span>
                  {model.description && (
                    <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-qn-muted">
                      {localizeModelDescription(model.description)}
                    </span>
                  )}
                </span>
                {selected && <Check size={16} className="shrink-0 text-qn-text" />}
              </ListOption>
            )
          })}
        </div>

        {selection.model && (selection.model.efforts.length > 0 || selection.fastTier) && (
          <div className="space-y-2 border-t border-qn-border px-3.5 py-3">
            {selection.model.efforts.length > 0 && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-[13px] text-qn-muted">推理强度</span>
                <div className="flex flex-wrap justify-end gap-1" role="radiogroup" aria-label="推理强度">
                  {selection.model.efforts.map((effort) => {
                    const active = effort.value === selection.effort
                    const button = (
                      <button
                        key={effort.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={cn(
                          'h-8 rounded-lg px-2.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                          active ? 'bg-qn-active font-medium text-qn-text' : 'text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                        )}
                        onClick={() => setPrefs(agent, { effort: effort.value })}
                      >
                        {effortLabel(effort.value)}
                      </button>
                    )
                    const hint = effortHint(effort.value, effort.description)
                    return hint ? (
                      <Tip key={effort.value} label={hint}>
                        {button}
                      </Tip>
                    ) : (
                      button
                    )
                  })}
                </div>
              </div>
            )}
            {selection.fastTier && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-[13px] text-qn-muted">速度</span>
                <Tip label="优先处理请求，响应更快，额度消耗更多">
                <button
                  type="button"
                  aria-pressed={selection.fast}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-qn-accent',
                    selection.fast
                      ? 'border-qn-warn/50 bg-qn-warn/10 text-qn-warn'
                      : 'border-qn-border-strong text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                  )}
                  onClick={() => setPrefs(agent, { fast: !selection.fast })}
                >
                  <Zap size={14} /> 快速
                </button>
                </Tip>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </PopoverRoot>
  )
}

/** 上下文窗口占用环（参考 Codex 输入框右下角）；拿不到窗口大小时不显示。 */
export function ContextRing({ tokenUsage }: { tokenUsage: unknown }) {
  const usage = contextUsage(tokenUsage)
  if (!usage) return null
  const tone = usage.percent >= 90 ? '#ff6b63' : usage.percent >= 75 ? '#e2b55d' : '#a1a1aa'
  return (
    <Tip label={`上下文已用 ${usage.percent}% · ${formatTokens(usage.used)} / ${formatTokens(usage.window)} tokens`}>
      <span className="inline-flex h-8 w-8 items-center justify-center" role="img" aria-label={`上下文已用 ${usage.percent}%`}>
        <ProgressRing percent={usage.percent} size={14} color={tone} />
      </span>
    </Tip>
  )
}
