import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, PencilLine, RotateCw, Search, Zap } from 'lucide-react'
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
import { PopoverContent, PopoverRoot, PopoverTrigger, Tip } from './primitives'

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
  const visible = useMemo(() => {
    const filtered = filterModels(models, query)
    // 当前生效的自定义模型不在服务端列表里，放在最前面，让用户看得到自己选了什么。
    const current = selection.model
    if (current && current.id.startsWith('custom:') && filterModels([current], query).length > 0) {
      return [current, ...filtered]
    }
    return filtered
  }, [models, query, selection.model])
  const typed = query.trim()
  const canUseCustom = typed.length > 0 && !/\s/.test(typed) && !visible.some((item) => item.model === typed)

  if (!opened || (models.length === 0 && !list?.loading && !list?.error)) return null

  const pick = (model: string) => {
    const option = models.find((item) => item.model === model)
    // 换模型时强度若不被新模型支持，交给 resolveSelection 回落到默认，这里不清空偏好里的强度。
    setPrefs(agent, { model, custom: false, ...(option && prefs.effort && !option.efforts.some((e) => e.value === prefs.effort) ? { effort: null } : {}) })
  }

  const pickCustom = (model: string) => {
    setPrefs(agent, { model, custom: true })
    setQuery('')
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
            <LoaderCircle size={13} className="animate-spin" />
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
        <div className="flex items-center gap-2.5 border-b border-qn-border px-3.5 py-3">
          <Search size={16} className="shrink-0 text-qn-dim" />
          <input
            ref={searchRef}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-qn-text outline-none placeholder:text-qn-dim"
            placeholder="搜索模型，或输入模型 ID…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              if (visible[0]) {
                event.preventDefault()
                if (visible[0].id.startsWith('custom:')) pickCustom(visible[0].model)
                else pick(visible[0].model)
                setQuery('')
              } else if (canUseCustom) {
                event.preventDefault()
                pickCustom(typed)
              }
            }}
          />
        </div>

        <div className="qn-scroll max-h-[min(320px,45vh)] overflow-y-auto p-1.5" role="listbox" aria-label="模型">
          {list?.error && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-qn-danger">
              <span className="min-w-0 flex-1">{list.error}</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-qn-muted hover:text-qn-text"
                onClick={() => session && void load(targetId, agent, session.rpc, true)}
              >
                <RotateCw size={13} /> 重试
              </button>
            </div>
          )}
          {list?.loading && models.length === 0 && (
            <div className="px-2.5 py-3 text-[13px] text-qn-muted">正在加载模型…</div>
          )}
          {!list?.loading && visible.length === 0 && models.length > 0 && !canUseCustom && (
            <div className="px-2.5 py-3 text-center text-[13px] text-qn-muted">没有匹配的模型</div>
          )}
          {visible.map((model) => {
            const selected = model.model === selection.model?.model
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:bg-qn-hover',
                  selected ? 'bg-qn-active' : 'hover:bg-qn-hover',
                )}
                onClick={() => (model.id.startsWith('custom:') ? pickCustom(model.model) : pick(model.model))}
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
              </button>
            )
          })}
          {canUseCustom && (
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-qn-hover focus-visible:bg-qn-hover"
              onClick={() => pickCustom(typed)}
            >
              <PencilLine size={15} className="shrink-0 text-qn-dim" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-qn-text">
                  使用模型 ID「<span className="font-mono">{typed}</span>」
                </span>
                <span className="mt-0.5 block text-[12px] text-qn-muted">不在列表中，按原样发送给 Agent（适合代理/自定义模型）</span>
              </span>
            </button>
          )}
        </div>

        {selection.model && (selection.model.efforts.length > 0 || selection.fastTier) && (
          <div className="space-y-2 border-t border-qn-border px-3.5 py-3">
            {selection.model.efforts.length > 0 && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-[13px] text-qn-muted">推理强度</span>
                <div className="flex flex-wrap justify-end gap-0.5" role="radiogroup" aria-label="推理强度">
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
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const tone = usage.percent >= 90 ? '#ff6b63' : usage.percent >= 75 ? '#e2b55d' : '#a1a1aa'
  return (
    <Tip label={`上下文已用 ${usage.percent}% · ${formatTokens(usage.used)} / ${formatTokens(usage.window)} tokens`}>
      <span className="inline-flex h-8 w-8 items-center justify-center" role="img" aria-label={`上下文已用 ${usage.percent}%`}>
        <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
          <circle cx="9" cy="9" r={radius} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={tone}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - usage.percent / 100)}
          />
        </svg>
      </span>
    </Tip>
  )
}
