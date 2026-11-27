import { useEffect, useMemo, useRef, useState } from 'react'
import { estimatedTurnUsage } from '@qn/codex-client'
import { Check, ChevronDown, Gauge, Zap } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import { formatCost } from '../lib/claudeUsage'
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
import { EmptyState, ErrorNote, IconButton, Spinner } from './ui'

const triggerClass = 'inline-flex h-8 max-w-[16rem] items-center gap-1 rounded-lg px-2 text-ui text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover data-[state=open]:bg-qn-hover data-[state=open]:text-qn-text'

/**
 * 输入框里的模型选择器（参考 Codex）：搜索模型 → 选模型 → 推理强度分段 → 速度（Fast）开关。
 * 选择按 agent 记在本机，发送时作为 turn/start 的 model / effort / serviceTier 覆盖项。
 * pi 需要先有运行中的会话才能读到模型，冷启动时由用户主动开启。
 */
export function ModelPicker({ targetId, agent, threadId, piDraft, open: controlledOpen, onOpenChange }: {
  targetId: string
  agent: AgentKind
  threadId: string | null
  piDraft?: { start: () => void; starting: boolean; disabled: boolean }
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const key = sessionKey(targetId, agent)
  const rpc = useCodex((s) => {
    const session = s.sessions[key]
    return session?.opened ? session.rpc : undefined
  })
  const directory = useCodex((s) => s.sessions[key]?.openedConfig?.directory)
  const hasClaudeTurn = useCodex((s) => agent === 'claude' && threadId !== null &&
    s.sessions[key]?.state.threads[threadId]?.turns?.some((turn) => turn.outcome !== undefined) === true)
  const list = useModels((s) => s.lists[key])
  const prefs = useModels((s) => s.prefs[agent] ?? EMPTY_PREFS)
  const load = useModels((s) => s.load)
  const setPrefs = useModels((s) => s.setPrefs)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (rpc) void load(targetId, agent, rpc, agent === 'claude' || (agent === 'pi' && threadId !== null))
  }, [rpc, threadId, directory, hasClaudeTurn, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const visible = useMemo(() => filterModels(models, query), [models, query])

  const empty = models.length === 0 && !list?.loading && !list?.error
  if (!open && piDraft && (piDraft.starting || empty)) {
    return (
      <button
        type="button"
        className={cn(triggerClass, 'disabled:text-qn-dim')}
        title="启动 pi 会话后可选择模型"
        disabled={piDraft.disabled}
        onClick={piDraft.start}
      >
        {piDraft.starting ? <><LoadingIcon size={13} /> 正在启动 pi…</> : '启动 pi 以选择模型'}
      </button>
    )
  }
  if (!rpc || (!open && empty && agent !== 'pi')) return null

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
          className={triggerClass}
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
          inputClassName="text-ui-md"
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
            onRetry={() => void load(targetId, agent, rpc, true)}
          />
          {list?.loading && models.length === 0 && (
            <div className="px-2.5 py-3"><Spinner label="正在加载模型…" /></div>
          )}
          {!list?.loading && visible.length === 0 && models.length > 0 && (
            <EmptyState className="px-2.5 py-3 leading-5">没有匹配的模型</EmptyState>
          )}
          {agent === 'pi' && empty && (
            <EmptyState className="px-2.5 py-3 leading-5">
              <p>暂无可用模型。请在目标机器的 pi 中配置模型后重试。</p>
              <button type="button" className={triggerClass} onClick={() => void load(targetId, agent, rpc, true)}>
                重新加载
              </button>
            </EmptyState>
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
                  <span className="block truncate text-ui-md font-medium text-qn-text">{model.displayName}</span>
                  {model.description && (
                    <span className="mt-0.5 line-clamp-2 block text-ui leading-5 text-qn-muted">
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
                <span className="shrink-0 text-ui text-qn-muted">推理强度</span>
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
                          'h-8 rounded-lg px-2.5 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover',
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
                <span className="shrink-0 text-ui text-qn-muted">速度</span>
                <Tip label="优先处理请求，响应更快，额度消耗更多">
                <button
                  type="button"
                  aria-pressed={selection.fast}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg border border-qn-border-strong px-3 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover',
                    selection.fast
                      ? 'bg-qn-warn/10 text-qn-warn'
                      : 'text-qn-muted hover:bg-qn-hover hover:text-qn-text',
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

/** 有窗口大小时显示占用环；Claude 和 pi 只有单轮统计时显示用量详情。 */
export function ContextRing({ tokenUsage, onClick }: { tokenUsage: unknown; onClick?: () => void }) {
  const usage = contextUsage(tokenUsage)
  if (onClick) {
    const tone = usage && (usage.percent >= 90 ? 'var(--color-qn-danger)' : usage.percent >= 75 ? 'var(--color-qn-warn)' : 'var(--color-qn-muted)')
    return <IconButton label={usage ? `上下文已用 ${usage.percent}%` : '查看会话用量'} onClick={onClick}>
      {usage && tone ? <ProgressRing percent={usage.percent} size={14} color={tone} /> : <Gauge size={15} />}
    </IconButton>
  }
  if (!usage) {
    const turn = estimatedTurnUsage(tokenUsage)
    if (!turn) return null
    return (
      <PopoverRoot>
        <PopoverTrigger asChild>
          <IconButton label="查看最近一轮用量"><Gauge size={15} /></IconButton>
        </PopoverTrigger>
        <PopoverContent align="end">
          <div className="min-w-44 space-y-1 px-3 py-2 text-ui">
            <p className="font-medium">最近上报的单轮用量</p>
            {turn.tokens !== null && <p className="text-qn-muted">{formatTokens(turn.tokens)} tokens</p>}
            {turn.costUsd !== null && <p className="text-qn-muted">费用估算 {formatCost(turn.costUsd)}</p>}
          </div>
        </PopoverContent>
      </PopoverRoot>
    )
  }
  const tone = usage.percent >= 90 ? 'var(--color-qn-danger)' : usage.percent >= 75 ? 'var(--color-qn-warn)' : 'var(--color-qn-muted)'
  return (
    <Tip label={`上下文已用 ${usage.percent}% · ${formatTokens(usage.used)} / ${formatTokens(usage.window)} tokens`}>
      <span className="inline-flex h-8 w-8 items-center justify-center" role="img" aria-label={`上下文已用 ${usage.percent}%`}>
        <ProgressRing percent={usage.percent} size={14} color={tone} />
      </span>
    </Tip>
  )
}
