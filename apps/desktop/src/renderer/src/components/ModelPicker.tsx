import { useEffect, useMemo, useRef, useState } from 'react'
import { estimatedTurnUsage, t, toggleHiddenModel, translateMessage, withoutHiddenModels, type HiddenModels } from '@qn/codex-client'
import { Check, ChevronDown, Eye, EyeOff, SlidersHorizontal, Zap } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import { cn } from '../lib/cn'
import {
  contextUsage,
  effortHint,
  effortLabel,
  filterModels,
  localizeModelDescription,
  resolveSelection,
  triggerLabel,
} from '../lib/models'
import { useSetting, useSettings } from '../features/settings/settingsStore'
import { useCodex } from '../store/codex'
import { prefsFor, useModels } from '../store/models'
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
  // 每个会话各自记模型与强度；草稿（threadId 为 null）读写的是新会话默认。
  const prefs = useModels((s) => prefsFor(s, targetId, agent, threadId))
  const load = useModels((s) => s.load)
  const setPrefs = useModels((s) => s.setPrefs)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  const [query, setQuery] = useState('')
  // 管理模式：列出全部模型，点行切换隐藏；名单存在电脑设置里，手机经网关只读同一份。
  const [managing, setManaging] = useState(false)
  const hiddenList = useSetting((settings) => settings.general.hiddenModels?.[agent])
  const updateSettings = useSettings((s) => s.update)
  const searchRef = useRef<HTMLInputElement>(null)

  const savedConfig = useCodex((s) => threadId ? s.sessions[key]?.state?.threads[threadId]?.savedConfig : undefined)
  const seedFromHistory = useModels((s) => s.seedFromHistory)
  const scope = { targetId, threadId, saved: savedConfig }
  // 打开历史会话后，本机没记录就沿用该会话上次用的模型与强度，而不是最近一次在别处的选择。
  // 模型列表就绪后才能把历史里的模型对应到选项（Claude 历史记的是完整模型 ID），列表变化时重试。
  const listedModels = list?.models
  useEffect(() => {
    if (threadId) seedFromHistory(targetId, agent, threadId, savedConfig)
  }, [seedFromHistory, targetId, agent, threadId, savedConfig, listedModels])

  useEffect(() => {
    if (rpc) void load(targetId, agent, rpc, agent === 'claude' || (agent === 'pi' && threadId !== null))
  }, [rpc, threadId, directory, hasClaudeTurn, load, targetId, agent])

  const models = list?.models ?? []
  const selection = useMemo(() => resolveSelection(models, prefs), [models, prefs])
  const filtered = useMemo(() => filterModels(models, query), [models, query])
  const visible = useMemo(
    () => managing ? filtered : withoutHiddenModels(filtered, hiddenList, selection.model?.model),
    [managing, filtered, hiddenList, selection.model?.model],
  )

  const empty = models.length === 0 && !list?.loading && !list?.error
  if (!open && piDraft && (piDraft.starting || empty)) {
    return (
      <button
        type="button"
        className={cn(triggerClass, 'disabled:text-qn-dim')}
        title={t('启动 pi 会话后可选择模型')}
        disabled={piDraft.disabled}
        onClick={piDraft.start}
      >
        {piDraft.starting ? <><LoadingIcon size={13} /> {t('正在启动 pi…')}</> : t('启动 pi 以选择模型')}
      </button>
    )
  }
  if (!rpc || (!open && empty && agent !== 'pi')) return null

  const pick = (model: string) => {
    const option = models.find((item) => item.model === model)
    // 换模型时强度若不被新模型支持，交给 resolveSelection 回落到默认，这里不清空偏好里的强度。
    setPrefs(agent, { model, ...(option && prefs.effort && !option.efforts.some((e) => e.value === prefs.effort) ? { effort: null } : {}) }, scope)
  }

  const toggleHidden = (model: string) => {
    const next: HiddenModels = {}
    next[agent] = toggleHiddenModel(hiddenList, model)
    void updateSettings({ general: { hiddenModels: next } })
  }

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          setQuery('')
          setManaging(false)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClass}
          aria-label={t('选择模型与推理强度')}
        >
          {list?.loading && models.length === 0 ? (
            <LoadingIcon size={13} />
          ) : (
            selection.fast && <Zap size={13} className="shrink-0 text-qn-warn" />
          )}
          <span className="truncate">{triggerLabel(selection) || t('模型')}</span>
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
          label={t('搜索模型')}
          className="gap-2.5 border-b border-qn-border px-3.5 py-3"
          inputClassName="text-ui-md"
          placeholder={t('搜索模型…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible[0] && !managing) {
              event.preventDefault()
              pick(visible[0].model)
              setQuery('')
            }
          }}
        />
        {models.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-b border-qn-border px-3.5 py-1.5">
            <span className="min-w-0 truncate text-ui text-qn-muted">
              {managing
                ? t('隐藏的模型不会出现在电脑和手机的模型列表中')
                : hiddenList?.length ? t('{count} 个模型已隐藏', { count: hiddenList.length }) : ''}
            </span>
            <button
              type="button"
              aria-pressed={managing}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover',
                managing ? 'bg-qn-active text-qn-text' : 'text-qn-muted hover:bg-qn-hover hover:text-qn-text',
              )}
              onClick={() => setManaging((value) => !value)}
            >
              {managing ? t('完成') : <><SlidersHorizontal size={13} aria-hidden /> {t('管理模型')}</>}
            </button>
          </div>
        )}

        <div className="qn-scroll max-h-[min(320px,45vh)] space-y-1 overflow-y-auto p-1.5" role="listbox" aria-label={t('模型')}>
          <ErrorNote
            message={list?.error ?? null}
            variant="compact"
            onRetry={() => void load(targetId, agent, rpc, true)}
          />
          {list?.loading && models.length === 0 && (
            <div className="px-2.5 py-3"><Spinner label={t('正在加载模型…')} /></div>
          )}
          {!list?.loading && visible.length === 0 && models.length > 0 && (
            <EmptyState className="px-2.5 py-3 leading-5">{t('没有匹配的模型')}</EmptyState>
          )}
          {agent === 'pi' && empty && (
            <EmptyState className="px-2.5 py-3 leading-5">
              <p>{t('暂无可用模型。请在目标机器的 pi 中配置模型后重试。')}</p>
              <button type="button" className={triggerClass} onClick={() => void load(targetId, agent, rpc, true)}>
                {t('重新加载')}
              </button>
            </EmptyState>
          )}
          {managing && visible.map((model) => {
            const hidden = hiddenList?.includes(model.model) === true
            const name = translateMessage(model.displayName)
            return (
              <button
                key={model.id}
                type="button"
                aria-pressed={!hidden}
                aria-label={hidden ? t('显示 {name}', { name }) : t('隐藏 {name}', { name })}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none hover:bg-qn-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-qn-outline-hover"
                onClick={() => toggleHidden(model.model)}
              >
                <span className={cn('min-w-0 flex-1 truncate text-ui-md', hidden ? 'text-qn-muted line-through' : 'font-medium text-qn-text')}>{name}</span>
                {hidden ? <EyeOff size={15} className="shrink-0 text-qn-muted" aria-hidden /> : <Eye size={15} className="shrink-0 text-qn-text" aria-hidden />}
              </button>
            )
          })}
          {!managing && visible.map((model) => {
            const selected = model.model === selection.model?.model
            return (
              <ListOption
                key={model.id}
                selected={selected}
                className="px-3 py-2.5"
                onClick={() => pick(model.model)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-md font-medium text-qn-text">{translateMessage(model.displayName)}</span>
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
                <span className="shrink-0 text-ui text-qn-muted">{t('推理强度')}</span>
                <div className="flex flex-wrap justify-end gap-1" role="radiogroup" aria-label={t('推理强度')}>
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
                        onClick={() => setPrefs(agent, { effort: effort.value }, scope)}
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
                <span className="shrink-0 text-ui text-qn-muted">{t('速度')}</span>
                <Tip label={t('优先处理请求，响应更快，额度消耗更多')}>
                <button
                  type="button"
                  aria-pressed={selection.fast}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg border border-qn-border-strong px-3 text-ui outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover',
                    selection.fast
                      ? 'bg-qn-warn/10 text-qn-warn'
                      : 'text-qn-muted hover:bg-qn-hover hover:text-qn-text',
                  )}
                  onClick={() => setPrefs(agent, { fast: !selection.fast }, scope)}
                >
                  <Zap size={14} /> {t('快速')}
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

/** 详情卡用一位小数（126.7k），比输入框旁的 127K 更能看出实时变化。 */
export function formatTokensPrecise(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(value)
}

function usageTone(percent: number): string {
  return percent >= 90 ? 'var(--color-qn-danger)' : percent >= 75 ? 'var(--color-qn-warn)' : 'var(--color-qn-muted)'
}

/** 悬浮详情卡：标题 + 已用/窗口 + 进度条；只有单轮统计时列出 tokens。 */
function ContextUsageCard({ tokenUsage }: { tokenUsage: unknown }) {
  const usage = contextUsage(tokenUsage)
  const turn = estimatedTurnUsage(tokenUsage)
  if (usage) {
    const fill = usage.percent >= 75 ? usageTone(usage.percent) : 'var(--color-qn-text)'
    return (
      <div className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-6">
          <span className="text-ui font-medium text-qn-text">{t('上下文')}</span>
          <span className="text-ui tabular-nums text-qn-muted">
            {formatTokensPrecise(usage.used)}/{formatTokensPrecise(usage.window)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-qn-border-strong" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage.percent}>
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${usage.percent}%`, background: fill }} />
        </div>
      </div>
    )
  }
  if (turn) {
    return (
      <div className="space-y-1">
        <p className="text-ui font-medium text-qn-text">{t('最近上报的单轮用量')}</p>
        <p className="tabular-nums text-qn-muted">{formatTokensPrecise(turn.tokens)} tokens</p>
      </div>
    )
  }
  return <p className="text-qn-muted">{t('暂无会话用量')}</p>
}

/**
 * 用量统一显示为圆环，随 tokenUsage 实时更新；悬浮显示详情卡，点击打开会话用量面板。
 * 没有窗口大小（Claude、pi 只有单轮统计）时只画底环。
 */
export function ContextRing({ tokenUsage, onClick }: { tokenUsage: unknown; onClick?: () => void }) {
  const usage = contextUsage(tokenUsage)
  const turn = usage ? null : estimatedTurnUsage(tokenUsage)
  // 草稿没有会话也没有用量时不占位置。
  if (!onClick && !usage && !turn) return null
  const label = usage ? t('上下文已用 {percent}%', { percent: usage.percent })
    : turn ? t('查看最近一轮用量') : t('查看会话用量')
  const ring = <ProgressRing percent={usage?.percent ?? 0} size={18} color={usage ? usageTone(usage.percent) : 'var(--color-qn-muted)'} />
  const card = <ContextUsageCard tokenUsage={tokenUsage} />
  const cardClass = 'w-64 rounded-xl px-3.5 py-3'
  if (onClick) {
    return (
      <Tip label={card} side="top" align="end" className={cardClass}>
        <IconButton label={label} tooltip={false} onClick={onClick}>{ring}</IconButton>
      </Tip>
    )
  }
  return (
    <Tip label={card} side="top" align="end" className={cardClass}>
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg" role="img" aria-label={label} tabIndex={0}>
        {ring}
      </span>
    </Tip>
  )
}
